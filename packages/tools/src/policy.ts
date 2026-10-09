import { createHash } from "node:crypto";
import { requiresApproval, type ApprovalAction } from "@agent-city/core";
import type { Repo } from "@agent-city/db";
import { z } from "zod";
import type { ToolDefinition } from "./types";

/** JSON with object keys sorted at every level, so equal actions hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function hashAction(action: ApprovalAction): string {
  return createHash("sha256").update(canonicalJson(action)).digest("hex");
}

export const RATIONALE_FIELD = "_rationale";

/**
 * Approval-tier tools take a required `_rationale` (shown to Nico on the
 * approval card). It is stripped before the action is stored, so the executed
 * args are exactly the tool's own arguments.
 */
export function argsSchemaFor(tool: ToolDefinition): z.ZodType {
  if (!requiresApproval(tool.tier)) return tool.schema;
  const rationale = z.object({
    [RATIONALE_FIELD]: z.string().min(10).max(2_000).describe("Why this action is right, for Nico's approval card"),
  });
  return z.intersection(tool.schema, rationale);
}

/**
 * Scoped credential lookup (spec §7.4): Supabase Vault first
 * ('agent:<agent_id>:<integration>'), then an environment variable for local
 * development: AGENT_SECRET__<AGENT_ID>__<INTEGRATION>, uppercased with
 * non-alphanumerics as underscores, e.g. AGENT_SECRET__PARLAYLAB_BILLING_01__STRIPE.
 */
export async function resolveSecret(repo: Repo, agentId: string, integration: string): Promise<string | null> {
  try {
    const fromVault = await repo.getAgentSecret(agentId, integration);
    if (fromVault) return fromVault;
  } catch {
    // Vault unavailable (local dev without Supabase): fall through to env.
  }
  return process.env[secretEnvName(agentId, integration)] ?? null;
}

export function secretEnvName(agentId: string, integration: string): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `AGENT_SECRET__${clean(agentId)}__${clean(integration)}`;
}
