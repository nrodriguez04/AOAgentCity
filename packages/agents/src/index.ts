import { DEFAULT_MODEL_PRICING, DIVISIONS } from "@agent-city/core";
import type { Repo } from "@agent-city/db";
import devlogCrew from "../averageoutput/devlog-crew/crew";
import contentCrew from "../creatoros/content-crew/crew";
import hq from "../hq/agent";
import billing from "../parlaylab/billing/agent";
import growth from "../parlaylab/growth/agent";
import reviewCrew from "../parlaylab/review-crew/crew";
import support from "../parlaylab/support/agent";
import { isCrew, permissionsFor, type AgentDefinition, type CrewDefinition } from "./define";

export * from "./define";
export * from "./crew-inputs";
export { seedSql } from "./seed";

/** CrewAI crews: agents rows with runtime "crewai" (crews/<project> on CrewAI AMP). */
export const CREWS: CrewDefinition[] = [devlogCrew, contentCrew, reviewCrew];

export const AGENTS: AgentDefinition[] = [hq, billing, support, growth, ...CREWS];

export function crewDefinition(id: string): CrewDefinition | undefined {
  const def = agentDefinition(id);
  return def && isCrew(def) ? def : undefined;
}

/** Agents whose schedule is declared in worker code instead of synced to Trigger.dev. */
export const CODE_SCHEDULED_AGENT_IDS = new Set(["hq.hq-01"]);

export function agentDefinition(id: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.id === id);
}

/**
 * Upsert divisions, agents, tool grants and model pricing from code into the
 * database (the same rows supabase/seed.sql creates). Living division context
 * docs that agents have edited are kept.
 */
export async function syncToDatabase(repo: Repo): Promise<{ divisions: number; agents: number; permissions: number }> {
  for (const d of DIVISIONS) {
    await repo.upsertDivision({
      id: d.id,
      name: d.name,
      kind: d.kind,
      status: d.status,
      summary: d.summary,
      context_md: d.contextMd,
      city_slot: d.slot,
    });
  }
  let permissions = 0;
  for (const a of AGENTS) {
    await repo.upsertAgent({
      id: a.id,
      division_id: a.division,
      display_name: a.displayName,
      role: a.role,
      model_tier: a.modelTier,
      runtime: a.runtime,
      instructions: a.instructions,
      default_goal: a.defaultGoal,
      schedule_cron: a.schedule,
      daily_budget_usd: a.dailyBudgetUsd,
      enabled: a.enabled,
    });
    const grants = permissionsFor(a);
    await repo.replacePermissions(a.id, grants);
    permissions += grants.length;
  }
  for (const p of DEFAULT_MODEL_PRICING) await repo.upsertModelPricing(p);
  return { divisions: DIVISIONS.length, agents: AGENTS.length, permissions };
}
