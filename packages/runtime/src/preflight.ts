import type { Repo } from "@agent-city/db";
import { getTool, resolveSecret } from "@agent-city/tools";
import { alertConfigFromEnv } from "./alerts";

/**
 * Preflight: what is still missing before Agent City can do real work.
 *
 * Reads the live configuration (environment, database, owner, every enabled
 * agent's credentials) and returns a checklist. It never prints or returns a
 * secret, only whether one is present. `pnpm preflight` prints it; the deploy
 * workflow runs it after each deploy.
 */

export interface PreflightCheck {
  area: "worker" | "database" | "agents" | "alerts" | "approvals";
  name: string;
  ok: boolean;
  /** A failed required check means agents cannot run at all. */
  required: boolean;
  detail: string;
  /** What to do when it fails. */
  fix?: string;
}

type Env = Record<string, string | undefined>;

const VAULT_HINT = (name: string, shape: string) => `In Supabase's SQL editor: select vault.create_secret('${shape}', '${name}');`;

/** The credential shape each integration expects in Vault (never a real value). */
const SECRET_SHAPES: Record<string, string> = {
  stripe: "rk_live_...",
  email: "re_... (or Gmail OAuth JSON)",
  gmail: '{"provider":"gmail","client_id":"...","client_secret":"...","refresh_token":"..."}',
  github: "github_pat_... (fine-grained, read-only Contents)",
  crewai: '{"url":"https://<deployment>.crewai.com","token":"..."}',
};

export interface PreflightOptions {
  repo: Repo;
  env?: Env;
  /**
   * Check the worker's own variables (ANTHROPIC_API_KEY, EMAIL_FROM, ALERTS_*). Off in the
   * deploy workflow, where those live in Trigger.dev rather than in the job's environment.
   */
  workerEnv?: boolean;
}

export async function preflight(deps: PreflightOptions): Promise<PreflightCheck[]> {
  const env = deps.env ?? process.env;
  const workerEnv = deps.workerEnv ?? true;
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => {
    if (workerEnv || (c.area !== "worker" && c.area !== "alerts")) checks.push(c);
  };

  // Worker environment -------------------------------------------------------
  const anthropic = Boolean(env.ANTHROPIC_API_KEY);
  add({
    area: "worker",
    name: "ANTHROPIC_API_KEY",
    ok: anthropic,
    required: true,
    detail: anthropic ? "set" : "not set: Claude agents cannot run",
    fix: "Trigger.dev project -> Environment variables -> Production: ANTHROPIC_API_KEY.",
  });

  // Database -------------------------------------------------------------------
  let agents: Awaited<ReturnType<Repo["listAgents"]>>;
  try {
    agents = await deps.repo.listAgents();
  } catch (err) {
    add({
      area: "database",
      name: "DATABASE_URL",
      ok: false,
      required: true,
      detail: `cannot read the database: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Supabase -> Project Settings -> Database -> Connection string (Transaction pooler), as DATABASE_URL.",
    });
    return checks;
  }
  add({ area: "database", name: "DATABASE_URL", ok: true, required: true, detail: `connected (${agents.length} agents)` });

  const [owners] = await deps.repo.sql.query<{ n: number }>(`select count(*)::int as n from owners`);
  add({
    area: "database",
    name: "Owner account",
    ok: (owners?.n ?? 0) > 0,
    required: true,
    detail: owners?.n ? `${owners.n} owner(s) registered` : "nobody can see the city or decide approvals yet",
    fix: "Sign in to the city once; it shows the one SQL statement that makes you the owner.",
  });

  const settings = await deps.repo.getSettings();
  if (settings.agents_paused) {
    add({ area: "database", name: "Pause switch", ok: false, required: false, detail: "agents are paused: every run exits immediately", fix: "Resume from the city, or set settings.agents_paused = false." });
  }

  // Agents and their credentials --------------------------------------------------
  const enabled = agents.filter((a) => a.enabled);
  add({ area: "agents", name: "Enabled agents", ok: enabled.length > 0, required: false, detail: `${enabled.length} enabled: ${enabled.map((a) => a.display_name).join(", ") || "none"}` });

  let needsEmailFrom = false;
  for (const agent of enabled) {
    const permissions = await deps.repo.listPermissions(agent.id);
    const integrations = new Set<string>();
    for (const p of permissions) {
      const tool = getTool(p.tool_name);
      if (tool && tool.integration !== "internal") integrations.add(tool.integration);
      if (p.tool_name === "email.send") needsEmailFrom = true;
    }
    if (agent.runtime === "crewai") integrations.add("crewai");
    for (const integration of [...integrations].sort()) {
      const name = `agent:${agent.id}:${integration}`;
      const present = Boolean(await resolveSecret(deps.repo, agent.id, integration));
      add({
        area: "agents",
        name: `${agent.display_name}: ${integration}`,
        ok: present,
        required: false,
        detail: present ? `${name} is stored` : `${name} is missing: ${agent.display_name} ${agent.runtime === "crewai" && integration === "crewai" ? "is skipped" : "fails when it needs this tool"}`,
        fix: VAULT_HINT(name, SECRET_SHAPES[integration] ?? "..."),
      });
    }
  }
  if (needsEmailFrom) {
    const from = Boolean(env.EMAIL_FROM);
    add({ area: "worker", name: "EMAIL_FROM", ok: from, required: false, detail: from ? "set" : "not set: approved emails cannot be sent", fix: 'Trigger.dev environment variable, e.g. "ParlayLab <support@yourdomain.com>".' });
  }

  // Alerts -------------------------------------------------------------------------
  const alerts = alertConfigFromEnv(env);
  add({
    area: "alerts",
    name: "Owner alerts",
    ok: !("missing" in alerts),
    required: false,
    detail: "missing" in alerts ? `off: ${alerts.missing.join(", ")} not set` : `on, to ${maskAddress(alerts.to)}${alerts.cityUrl ? "" : " (CITY_URL not set: emails carry no link)"}`,
    fix: "Trigger.dev environment variables: ALERTS_RESEND_API_KEY, ALERTS_EMAIL_TO, ALERTS_EMAIL_FROM, CITY_URL.",
  });

  // Instant approvals --------------------------------------------------------------
  let dispatchKey = false;
  try {
    const [row] = await deps.repo.sql.query<{ ok: boolean }>(
      `select exists (select 1 from vault.decrypted_secrets where name = 'trigger_secret_key') as ok`,
    );
    dispatchKey = Boolean(row?.ok);
  } catch {
    dispatchKey = false;
  }
  add({
    area: "approvals",
    name: "Instant approval execution",
    ok: dispatchKey,
    required: false,
    detail: dispatchKey ? "the database calls Trigger.dev as soon as you approve" : "approved actions run within 5 minutes (the sweeper), not instantly",
    fix: VAULT_HINT("trigger_secret_key", "tr_prod_..."),
  });

  return checks;
}

/** Plain-text report for the CLI and the deploy log. */
export function formatPreflight(checks: PreflightCheck[]): string {
  const lines = ["Agent City preflight", ""];
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.required ? "FAIL" : "todo";
    lines.push(`${mark}  ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`      -> ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.ok && c.required).length;
  const todo = checks.filter((c) => !c.ok && !c.required).length;
  lines.push("", failed ? `${failed} required item(s) missing, ${todo} to do.` : todo ? `Ready to run. ${todo} item(s) still to do.` : "Everything is configured.");
  return lines.join("\n");
}

function maskAddress(address: string): string {
  return address.replace(/^(.)[^@]*@/, "$1***@");
}
