import { createHash } from "node:crypto";
import { CITY_TIMEZONE, formatMinorUnits, type AgentRow, type ApprovalRow, type BriefRow, type DivisionRow, type RunRow } from "@agent-city/core";
import type { Repo } from "@agent-city/db";

/**
 * Owner alerts: email Nico what needs him, so approvals reach his phone instead
 * of waiting until he opens the city.
 *
 *   - a digest of newly pending approvals and newly failed runs;
 *   - HQ-01's brief, as soon as it is published.
 *
 * Runs every few minutes (the worker's `owner-alerts` schedule). Items are
 * claimed before sending, so overlapping runs never email the same item twice;
 * a failed send releases its claims and the next run retries. Customer email
 * addresses and phone numbers are masked in every alert.
 */

export interface AlertConfig {
  /** Resend API key used only for alerts. */
  resendApiKey: string;
  /** Nico's address. */
  to: string;
  /** Verified Resend sender, e.g. "Agent City <alerts@yourdomain.com>". */
  from: string;
  /** Link to the city, included in every email. */
  cityUrl: string | null;
}

export const ALERT_ENV = {
  apiKey: "ALERTS_RESEND_API_KEY",
  to: "ALERTS_EMAIL_TO",
  from: "ALERTS_EMAIL_FROM",
  cityUrl: "CITY_URL",
} as const;

/** Alert settings from the worker environment, or the names of what is missing. */
export function alertConfigFromEnv(env: Record<string, string | undefined> = process.env): AlertConfig | { missing: string[] } {
  const resendApiKey = env[ALERT_ENV.apiKey] || undefined;
  const to = env[ALERT_ENV.to] || undefined;
  const from = env[ALERT_ENV.from] || env.EMAIL_FROM || undefined;
  const missing = [
    ...(resendApiKey ? [] : [ALERT_ENV.apiKey]),
    ...(to ? [] : [ALERT_ENV.to]),
    ...(from ? [] : [`${ALERT_ENV.from} (or EMAIL_FROM)`]),
  ];
  if (!resendApiKey || !to || !from) return { missing };
  return { resendApiKey, to, from, cityUrl: env[ALERT_ENV.cityUrl] || null };
}

export interface AlertEmail {
  kind: "digest" | "brief";
  subject: string;
  text: string;
  /** Claimed rows this email covers (released again if it fails). */
  items: { approvals: string[]; runs: string[]; briefs: string[] };
}

export interface AlertResult {
  kind: AlertEmail["kind"];
  subject: string;
  items: number;
  status: "sent" | "failed";
  messageId: string | null;
  error: string | null;
}

export type AlertsOutcome =
  | { status: "not_configured"; missing: string[] }
  | { status: "nothing_new" }
  | { status: "done"; results: AlertResult[] };

export interface AlertDeps {
  repo: Repo;
  config: AlertConfig | { missing: string[] };
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Only items from the last day are alerted, so a first deploy does not email old history. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function sendOwnerAlerts(deps: AlertDeps): Promise<AlertsOutcome> {
  if ("missing" in deps.config) return { status: "not_configured", missing: deps.config.missing };
  const config = deps.config;
  const now = deps.now ?? (() => new Date());
  const since = new Date(now().getTime() - LOOKBACK_MS);

  const approvals = await deps.repo.claimUnnotifiedApprovals();
  const runs = await deps.repo.claimUnnotifiedFailedRuns(since);
  const briefs = await deps.repo.claimUnnotifiedBriefs(since);
  if (approvals.length + runs.length + briefs.length === 0) return { status: "nothing_new" };

  const [agents, divisions] = await Promise.all([deps.repo.listAgents(), deps.repo.listDivisions()]);
  const names = { agents: new Map(agents.map((a) => [a.id, a])), divisions: new Map(divisions.map((d) => [d.id, d])) };

  const emails: AlertEmail[] = [];
  if (approvals.length || runs.length) emails.push(composeDigest(approvals, runs, names, config.cityUrl));
  for (const brief of briefs) emails.push(composeBrief(brief, config.cityUrl));

  const results: AlertResult[] = [];
  for (const email of emails) {
    const count = email.items.approvals.length + email.items.runs.length + email.items.briefs.length;
    try {
      const messageId = await sendWithResend(email, config, deps.fetch ?? fetch);
      await deps.repo.recordNotification({ kind: email.kind, subject: email.subject, item_count: count, status: "sent", provider_message_id: messageId, error: null });
      results.push({ kind: email.kind, subject: email.subject, items: count, status: "sent", messageId, error: null });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.repo.releaseNotificationClaims(email.items);
      await deps.repo.recordNotification({ kind: email.kind, subject: email.subject, item_count: count, status: "failed", provider_message_id: null, error: error.slice(0, 500) });
      results.push({ kind: email.kind, subject: email.subject, items: count, status: "failed", messageId: null, error });
    }
  }
  return { status: "done", results };
}

type Names = { agents: Map<string, AgentRow>; divisions: Map<string, DivisionRow> };

export function composeDigest(approvals: ApprovalRow[], runs: RunRow[], names: Names, cityUrl: string | null): AlertEmail {
  const who = (agentId: string, divisionId?: string) => {
    const agent = names.agents.get(agentId);
    const division = names.divisions.get(divisionId ?? agent?.division_id ?? "");
    return `${division?.name ?? divisionId ?? "?"} / ${agent?.display_name ?? agentId}`;
  };

  const lines: string[] = [];
  if (approvals.length) {
    lines.push(`${plural(approvals.length, "approval")} waiting for you`, "");
    for (const a of approvals) {
      const amount = a.amount_cents != null ? ` (${formatMinorUnits(a.amount_cents, a.currency ?? "usd")})` : "";
      lines.push(`- ${who(a.agent_id, a.division_id)}: ${a.title}${amount}`);
      lines.push(`  ${a.tier === "financial" ? "Moves money" : "Leaves the building"}. Expires ${clock(a.expires_at)}.`);
      lines.push(`  Why: ${clip(a.rationale, 240)}`);
    }
    lines.push("");
  }
  if (runs.length) {
    lines.push(`${plural(runs.length, "run")} failed`, "");
    for (const r of runs) lines.push(`- ${who(r.agent_id)}, ${clock(r.ended_at ?? r.created_at)}: ${clip(r.error ?? "no error recorded", 240)}`);
    lines.push("");
  }
  lines.push(cityUrl ? `Decide in Agent City: ${cityUrl}` : "Decide in Agent City.");
  if (approvals.length) lines.push("Nothing is sent, charged or refunded until you approve it. Approvals expire after 72 hours.");

  const parts = [approvals.length ? `${plural(approvals.length, "approval")} waiting` : null, runs.length ? `${plural(runs.length, "run")} failed` : null];
  return {
    kind: "digest",
    subject: `Agent City: ${parts.filter(Boolean).join(", ")}`,
    text: redactContacts(lines.join("\n")),
    items: { approvals: approvals.map((a) => a.id), runs: runs.map((r) => r.id), briefs: [] },
  };
}

export function composeBrief(brief: BriefRow, cityUrl: string | null): AlertEmail {
  const headline = brief.body_md
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find((l) => l.length > 0);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, weekday: "short", month: "short", day: "numeric" }).format(new Date(brief.created_at));
  return {
    kind: "brief",
    subject: clip(`HQ brief, ${day}: ${headline ?? "today's brief"}`, 200),
    text: redactContacts(`${brief.body_md.trim()}\n\n${cityUrl ? `Open Agent City: ${cityUrl}` : "Open Agent City for details."}`),
    items: { approvals: [], runs: [], briefs: [brief.id] },
  };
}

/**
 * Mask contact details before they leave in an email: "jordan@example.com" ->
 * "j***@example.com", "(312) 555-0142" -> "[phone]". Alerts go to Nico's own inbox,
 * but customer contact details don't need to travel there.
 */
export function redactContacts(text: string): string {
  return text
    .replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, "$1***@$2")
    .replace(/(?<![\w$])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\w)/g, "[phone]");
}

async function sendWithResend(email: AlertEmail, config: AlertConfig, fetchFn: typeof fetch): Promise<string | null> {
  const ids = [...email.items.approvals, ...email.items.runs, ...email.items.briefs].sort().join(",");
  const response = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
      // The same claimed items never produce two emails, even if a retry races a slow success.
      "Idempotency-Key": `alert:${email.kind}:${createHash("sha256").update(ids).digest("hex").slice(0, 32)}`,
    },
    body: JSON.stringify({ from: config.from, to: [config.to], subject: email.subject, text: email.text }),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) throw new Error(`Resend ${response.status}: ${body.message ?? "error"}`);
  return body.id ?? null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function clock(isoTime: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(isoTime));
}
