import { requiresApproval, TIER_LABELS } from "@agent-city/core";
import { z } from "zod";
import { EMAIL_TOOLS } from "./integrations/email";
import { SUPPORT_TOOLS } from "./integrations/gmail";
import { HQ_TOOLS } from "./integrations/hq";
import { INTERNAL_TOOLS } from "./integrations/internal";
import { STRIPE_TOOLS } from "./integrations/stripe";
import { RATIONALE_FIELD } from "./policy";
import type { ToolDefinition } from "./types";

// Every tool is registered here with a tier. There are no unregistered tools:
// the gateway rejects any name it cannot find (spec §13).
export const ALL_TOOLS: ToolDefinition[] = [
  ...INTERNAL_TOOLS,
  ...HQ_TOOLS,
  ...STRIPE_TOOLS,
  ...EMAIL_TOOLS,
  ...SUPPORT_TOOLS,
] as unknown as ToolDefinition[];

export const registry = new Map<string, ToolDefinition>();
const byApiName = new Map<string, ToolDefinition>();

// Claude tool names must match ^[a-zA-Z0-9_-]{1,64}$, so registry names like
// "stripe.list_subscriptions" are sent as "stripe__list_subscriptions".
export const toApiName = (name: string) => name.replaceAll(".", "__");

for (const tool of ALL_TOOLS) {
  if (registry.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
  const apiName = toApiName(tool.name);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(apiName)) throw new Error(`tool name not API-safe: ${tool.name}`);
  registry.set(tool.name, tool);
  byApiName.set(apiName, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function toolFromApiName(apiName: string): ToolDefinition | undefined {
  return byApiName.get(apiName);
}

export interface ApiToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}

/** The tool definition sent to the Messages API. */
export function apiToolDefinition(tool: ToolDefinition): ApiToolDefinition {
  const schema = z.toJSONSchema(tool.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  const required = [...((schema.required as string[]) ?? [])];
  let description = `${tool.description}\n[Tier: ${TIER_LABELS[tool.tier]}]`;
  if (requiresApproval(tool.tier)) {
    properties[RATIONALE_FIELD] = {
      type: "string",
      description: "Why this action is right. Shown to Nico on the approval card.",
      minLength: 10,
      maxLength: 2000,
    };
    required.push(RATIONALE_FIELD);
    description +=
      " Calling this does NOT perform the action: it queues an approval for Nico and returns at once. Do not call it again for the same action.";
  }
  return {
    name: toApiName(tool.name),
    description,
    input_schema: { ...schema, type: "object", properties, required },
  };
}

/**
 * API tool definitions for a set of granted tool names, in a stable order so the
 * request prefix (and its prompt cache) does not change between runs.
 */
export function apiToolsFor(toolNames: Iterable<string>): ApiToolDefinition[] {
  return [...new Set(toolNames)]
    .sort()
    .map((name) => registry.get(name))
    .filter((t): t is ToolDefinition => Boolean(t))
    .map(apiToolDefinition);
}
