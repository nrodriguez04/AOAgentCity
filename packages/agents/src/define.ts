import { readFileSync } from "node:fs";
import type { AgentRuntime, CrewSpec, ModelTier } from "@agent-city/core";
import { getTool } from "@agent-city/tools";

/** An agent's definition in code: the source of truth synced into `agents` + `agent_permissions`. */
export interface AgentDefinition {
  id: string;
  division: string;
  displayName: string;
  role: string;
  modelTier: ModelTier;
  /** "claude": the worker's tool-use loop. "crewai": a crew on CrewAI AMP (see defineCrew). */
  runtime: AgentRuntime;
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

export function defineAgent(def: Omit<AgentDefinition, "enabled" | "runtime"> & { enabled?: boolean }): AgentDefinition {
  checkTools(def.id, def.tools);
  return { ...def, runtime: "claude", enabled: def.enabled ?? true };
}

function checkTools(id: string, tools: string[]): void {
  for (const name of tools) {
    if (!getTool(name)) throw new Error(`${id}: unknown tool "${name}"`);
  }
  if (new Set(tools).size !== tools.length) throw new Error(`${id}: duplicate tools`);
}

/**
 * A CrewAI crew that works alongside the Claude agents. It is an agents row with
 * runtime "crewai": same division, schedule, budget, tool grants and runs. The
 * crew itself lives in crews/<project> and runs on CrewAI AMP; Agent City
 * builds its inputs, follows its progress and applies its result.
 */
export interface CrewDefinition extends AgentDefinition, CrewSpec {
  runtime: "crewai";
}

/** Tools every crew needs to hand its result back: drafts, tasks and metrics. */
export const CREW_OUTPUT_TOOLS = ["draft.save", "task.create", "metric.record"] as const;

export function defineCrew(
  def: Omit<CrewDefinition, "enabled" | "runtime" | "modelTier"> & { enabled?: boolean; modelTier?: ModelTier },
): CrewDefinition {
  checkTools(def.id, def.tools);
  for (const name of CREW_OUTPUT_TOOLS) {
    if (!def.tools.includes(name)) throw new Error(`${def.id}: crews need the "${name}" tool to return their result`);
  }
  if (def.tasks.length === 0) throw new Error(`${def.id}: a crew needs at least one task`);
  return { ...def, runtime: "crewai", modelTier: def.modelTier ?? "standard", enabled: def.enabled ?? true };
}

export function isCrew(def: AgentDefinition): def is CrewDefinition {
  return def.runtime === "crewai";
}

export function readInstructions(url: URL): string {
  return readFileSync(url, "utf8").trim();
}

/** The agent_permissions rows for an agent: every tool at exactly its registered tier. */
export function permissionsFor(def: AgentDefinition) {
  return def.tools.map((name) => ({ tool_name: name, max_tier: getTool(name)!.tier }));
}
