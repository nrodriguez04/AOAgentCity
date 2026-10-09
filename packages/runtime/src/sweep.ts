import { toSummary } from "@agent-city/core";
import { emit, type Repo } from "@agent-city/db";
import type { ToolServices } from "@agent-city/tools";
import { executeApproval, settleRun, type ExecuteOutcome } from "./approvals";

export interface SweepReport {
  expired: number;
  executed: Record<string, ExecuteOutcome>;
  stuckReported: number;
  staleRunsFailed: number;
}

const APPROVED_GRACE_MS = 30_000;
const STUCK_EXECUTION_MS = 15 * 60 * 1000;
const STALE_RUN_MS = 20 * 60 * 1000;

/**
 * Housekeeping, run every 5 minutes by the worker:
 *   1. pending approvals past expires_at (72 h) become expired;
 *   2. approved actions that the database webhook did not deliver are executed
 *      (executeApproval is idempotent, so a double delivery is harmless);
 *   3. actions whose executor died mid-action are reported once, in red. They
 *      stay "executing" (never retried automatically, and the same action can't
 *      be re-proposed) until a human checks the integration;
 *   4. runs stuck in "running" (a crashed worker) are marked failed.
 */
export async function sweep(deps: { repo: Repo; services?: Pick<ToolServices, "fetch">; now?: () => Date }): Promise<SweepReport> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  const expired = await repo.expireStaleApprovals(now());
  for (const approval of expired) {
    await emit(
      repo,
      {
        division_id: approval.division_id,
        agent_id: approval.agent_id,
        run_id: approval.run_id ?? undefined,
        type: "approval.decided",
        level: "warning",
        summary: toSummary(`Expired: ${approval.title}`),
        payload: { approval_id: approval.id, status: "expired" },
      },
      { agentState: null },
    );
    const agent = await repo.getAgent(approval.agent_id);
    if (agent?.state === "waiting_approval" && (await repo.countPendingApprovals(agent.id)) === 0) {
      await repo.setAgentState(agent.id, "idle");
    }
    await settleRun(repo, approval);
  }

  const executed: Record<string, ExecuteOutcome> = {};
  const awaiting = await repo.listApprovedAwaitingExecution(new Date(now().getTime() - APPROVED_GRACE_MS));
  for (const approval of awaiting) {
    executed[approval.id] = await executeApproval(deps, approval.id);
  }

  const stuck = await repo.listStuckExecuting(new Date(now().getTime() - STUCK_EXECUTION_MS));
  for (const approval of stuck) {
    await emit(
      repo,
      {
        division_id: approval.division_id,
        agent_id: approval.agent_id,
        run_id: approval.run_id ?? undefined,
        type: "action.executed",
        level: "error",
        summary: toSummary(`Outcome unknown, check before retrying: ${approval.title}`),
        payload: { approval_id: approval.id, outcome: "unknown" },
      },
      { agentState: null },
    );
  }

  const stale = await repo.listStaleRunningRuns(new Date(now().getTime() - STALE_RUN_MS));
  for (const run of stale) {
    const agent = await repo.getAgent(run.agent_id);
    await repo.updateRun(run.id, { status: "failed", ended_at: now(), error: "worker lost (run never finished)" });
    if (agent) {
      await emit(
        repo,
        { division_id: agent.division_id, agent_id: agent.id, run_id: run.id, type: "run.failed", level: "error", summary: "Failed: worker lost (run never finished)" },
        { agentState: "error" },
      );
    }
  }

  return { expired: expired.length, executed, stuckReported: stuck.length, staleRunsFailed: stale.length };
}
