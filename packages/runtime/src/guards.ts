import { DEFAULT_RUN_COST_ESTIMATE_USD, formatUsd, startOfDayInZone, type AgentRow } from "@agent-city/core";
import type { Repo } from "@agent-city/db";

/**
 * Global kill switch (spec §8): AGENTS_PAUSED=true in the worker's environment,
 * or the "Pause city" button (settings.agents_paused). Checked before every run,
 * between every step, and before executing an approved action.
 */
export async function isPaused(repo: Repo): Promise<boolean> {
  if (process.env.AGENTS_PAUSED === "true") return true;
  return (await repo.getSettings()).agents_paused;
}

export interface BudgetCheck {
  ok: boolean;
  spentToday: number;
  estimate: number;
  budget: number;
  message: string;
}

/**
 * Spend today (America/Chicago) plus an estimate for this run must stay within
 * the agent's daily budget (spec §9). The estimate is the average of the agent's
 * last five completed runs, or a per-tier default before it has any history.
 */
export async function checkBudget(repo: Repo, agent: AgentRow, now: Date): Promise<BudgetCheck> {
  const spentToday = await repo.agentSpendSince(agent.id, startOfDayInZone(now));
  const recent = await repo.recentRunCosts(agent.id, 5);
  const estimate = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : DEFAULT_RUN_COST_ESTIMATE_USD[agent.model_tier];
  const budget = agent.daily_budget_usd;
  const ok = spentToday + estimate <= budget;
  return {
    ok,
    spentToday,
    estimate,
    budget,
    message: `${agent.display_name} has spent ${formatUsd(spentToday, 4)} of its ${formatUsd(budget)} daily budget (next run ~${formatUsd(estimate, 4)})`,
  };
}
