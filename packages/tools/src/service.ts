import { createHash } from "node:crypto";
import { divisionDefinition, type AppId, type RiskTier } from "@agent-city/core";
import type { z } from "zod";
import { defineTool, ToolError, UNTRUSTED_NOTICE, type ApprovalAmount, type ToolDefinition } from "./types";

// Tools that call a company app's agent API: the outbound half of the company
// connector (docs/CONNECTOR.md). Each agent has its own token per app, stored in
// Vault as agent:<agent_id>:<app> = {"base_url": "https://<app>/api/agent/v1", "token": "..."},
// so the app can scope it, rate-limit it and revoke it without touching other agents.
//
// The app stays the authority. Anything that leaves the building or binds the
// company becomes an approval inside the app, which Agent City mirrors
// (app_approvals), so app tools are normally read or internal_write. A tool
// declared external_effect or financial here still goes through Agent City's
// own approval queue first, like every other tool.

export interface ServiceToolSpec<Schema extends z.ZodObject> {
  app: AppId;
  /** "<app>.<verb>", e.g. "fedops.list_pursuits". */
  name: string;
  description: string;
  tier: RiskTier;
  method: "GET" | "POST" | "PATCH";
  /** Path under the agent API base. {field} segments are filled from the arguments: "/pursuits/{pursuit_id}". */
  path: string;
  schema: Schema;
  describe(args: z.output<Schema>): string;
  amount?(args: z.output<Schema>): ApprovalAmount | null;
  /** Whether results can carry text written by outsiders (solicitations, customer messages). Default true. */
  untrusted?: boolean;
}

export interface AppCredential {
  base_url: string;
  token: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 200_000;

const appName = (app: AppId) => divisionDefinition(app)?.name ?? app;

/** Reads the agent's credential for an app. https only, except a local dev server. */
export function parseAppCredential(secret: string | null, agentId: string, app: AppId): AppCredential {
  const where = `Vault secret agent:${agentId}:${app}`;
  if (!secret) throw new ToolError("missing_credential", `No ${appName(app)} token for ${agentId}. Store it in the ${where} as {"base_url": "...", "token": "..."}.`);
  let parsed: Partial<AppCredential>;
  try {
    parsed = JSON.parse(secret) as Partial<AppCredential>;
  } catch {
    throw new ToolError("bad_credential", `The ${where} is not JSON. It should be {"base_url": "...", "token": "..."}.`);
  }
  let url: URL | null = null;
  try {
    url = new URL(String(parsed.base_url));
  } catch {
    // reported below
  }
  const local = url?.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!url || !(url.protocol === "https:" || local) || url.username || url.password || url.search || url.hash) {
    throw new ToolError("bad_credential", `The ${where} needs base_url as a plain https:// address.`);
  }
  if (typeof parsed.token !== "string" || parsed.token.length < 16) {
    throw new ToolError("bad_credential", `The ${where} needs a token of at least 16 characters.`);
  }
  return { base_url: url.href.replace(/\/+$/, ""), token: parsed.token };
}

export function defineServiceTool<Schema extends z.ZodObject>(spec: ServiceToolSpec<Schema>): ToolDefinition<Schema> {
  if (!spec.name.startsWith(`${spec.app}.`)) throw new Error(`service tool ${spec.name} must be named ${spec.app}.<verb>`);
  if (!spec.path.startsWith("/")) throw new Error(`service tool ${spec.name}: path must start with /`);
  const pathFields = [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const shape = spec.schema.shape as Record<string, unknown>;
  for (const field of pathFields) {
    if (!(field in shape)) throw new Error(`service tool ${spec.name}: path field {${field}} is not in its schema`);
  }

  return defineTool({
    name: spec.name,
    description: spec.description,
    tier: spec.tier,
    integration: spec.app,
    schema: spec.schema,
    describe: spec.describe,
    amount: spec.amount,
    async execute(args, ctx) {
      const credential = parseAppCredential(ctx.secret, ctx.agent.id, spec.app);
      const rest: Record<string, unknown> = { ...(args as Record<string, unknown>) };
      let path = spec.path;
      for (const field of pathFields) {
        const value = rest[field];
        if (value === undefined || value === null || value === "") throw new ToolError("invalid_args", `${field} is required`);
        path = path.replace(`{${field}}`, encodeURIComponent(String(value)));
        delete rest[field];
      }

      const url = new URL(`${credential.base_url}${path}`);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credential.token}`,
        Accept: "application/json",
        "User-Agent": "agent-city",
        // Who is asking, so the app's audit trail names the agent and the run.
        "X-Agent-City-Agent": ctx.agent.id,
      };
      if (ctx.runId) headers["X-Agent-City-Run"] = ctx.runId;

      let body: string | undefined;
      if (spec.method === "GET") {
        for (const [key, value] of Object.entries(rest)) {
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
          else url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
      } else {
        body = JSON.stringify(rest);
        headers["Content-Type"] = "application/json";
        // An approved action retries under its approval id, anything else under its run and
        // arguments, so a retried call never writes twice.
        headers["Idempotency-Key"] =
          ctx.idempotencyKey ?? createHash("sha256").update(`${ctx.runId ?? "no-run"}|${spec.name}|${body}`).digest("hex").slice(0, 48);
      }

      let response: Response;
      try {
        response = await (ctx.services.fetch ?? fetch)(url, {
          method: spec.method,
          headers,
          body,
          // A redirect would carry the token somewhere the credential never named.
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ToolError(`${spec.app}_unreachable`, `${appName(spec.app)} did not answer (${reason.slice(0, 200)}).`);
      }

      const text = await response.text();
      if (!response.ok) throw httpError(spec.app, response.status, text, ctx.agent.id);
      if (text.length > MAX_RESPONSE_CHARS) {
        throw new ToolError(`${spec.app}_too_large`, `${appName(spec.app)} returned more than ${MAX_RESPONSE_CHARS} characters. Ask for less (a narrower filter or a lower limit).`);
      }
      let data: unknown = null;
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new ToolError(`${spec.app}_bad_response`, `${appName(spec.app)} answered with something that is not JSON.`);
        }
      }
      return spec.untrusted === false ? { app: spec.app, data } : { app: spec.app, notice: UNTRUSTED_NOTICE, data };
    },
  });
}

function httpError(app: AppId, status: number, text: string, agentId: string): ToolError {
  const name = appName(app);
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    detail = String(parsed.message ?? parsed.error ?? detail);
  } catch {
    // plain text
  }
  detail = detail.replace(/\s+/g, " ").slice(0, 300);
  const said = detail ? `: ${detail}` : ".";
  if (status === 401) return new ToolError(`${app}_unauthorized`, `${name} refused ${agentId}'s token (Vault agent:${agentId}:${app}). It is wrong, expired or revoked.`);
  if (status === 403) return new ToolError(`${app}_forbidden`, `${name} does not allow ${agentId} to do this${said}`);
  if (status === 404) return new ToolError(`${app}_not_found`, `${name} has no such record${said}`);
  if (status === 409) return new ToolError(`${app}_conflict`, `${name} refused because the record changed or the action already happened${said}`);
  if (status === 400 || status === 422) return new ToolError(`${app}_rejected`, `${name} rejected the request${said}`);
  if (status === 429) return new ToolError(`${app}_rate_limited`, `${name} is rate limiting ${agentId}. Do not retry in this run.`);
  return new ToolError(`${app}_unavailable`, `${name} failed with ${status}${said}`);
}
