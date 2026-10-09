import { readFileSync } from "node:fs";
import type { ModelTier } from "@agent-city/core";
import { getTool } from "@agent-city/tools";

/** An agent's definition in code: the source of truth synced into `agents` + `agent_permissions`. */
export interface AgentDefinition {
  id: string;
  division: string;
  displayName: string;
  role: string;
  modelTier: ModelTier;
  /** 5-field cron in America/Chicago, or null for on-demand only. */
  schedule: string | null;
  /** Goal for scheduled runs. HQ dispatches pass their own goal. */
  defaultGoal: string;
  instructions: string;
  /** Registry tool names. Each is granted at the tool's own tier (least privilege). */
  tools: string[];
  dailyBudgetUsd: number;
  enabled: boolean;
}

export function defineAgent(def: Omit<AgentDefinition, "enabled"> & { enabled?: boolean }): AgentDefinition {
  for (const name of def.tools) {
    if (!getTool(name)) throw new Error(`${def.id}: unknown tool "${name}"`);
  }
  if (new Set(def.tools).size !== def.tools.length) throw new Error(`${def.id}: duplicate tools`);
  return { ...def, enabled: def.enabled ?? true };
}

export function readInstructions(url: URL): string {
  return readFileSync(url, "utf8").trim();
}

/** The agent_permissions rows for an agent: every tool at exactly its registered tier. */
export function permissionsFor(def: AgentDefinition) {
  return def.tools.map((name) => ({ tool_name: name, max_tier: getTool(name)!.tier }));
}
