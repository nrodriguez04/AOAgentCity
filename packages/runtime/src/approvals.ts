import { tierAllows, toSummary, type ApprovalRow } from "@agent-city/core";
import { emit, type Repo } from "@agent-city/db";
import { describeError, getTool, resolveSecret, type ToolServices } from "@agent-city/tools";
import { isPaused } from "./guards";

export type ExecuteOutcome =
  | "executed"
  | "failed"
  | "expired"
  | "paused"
  | "not_found"
  | "not_approved"
  | "already_claimed";

/**
 * Execute an approved action exactly as stored (spec §7.3). The model is not
 * involved. Safe to call any number of times for the same approval: only the
 * caller that wins the approved -> executing transition runs the action, and the
 * approval id is passed to integrations as their idempotency key.
 */
export async function executeApproval(
  deps: { repo: Repo; services?: Pick<ToolServices, "fetch">; now?: () => Date },
  approvalId: string,
): Promise<ExecuteOutcome> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const approval = await repo.getApproval(approvalId);
  if (!approval) return "not_found";
  if (approval.status !== "approved") return approval.status === "executing" ? "already_claimed" : "not_approved";

  // Paused: leave it approved; the sweeper executes it once the city resumes.
  if (await isPaused(repo)) return "paused";

  const base = { division_id: approval.division_id, agent_id: approval.agent_id, run_id: approval.run_id ?? undefined };

  if (new Date(approval.expires_at).getTime() <= now().getTime()) {
    const expired = await repo.transitionApproval(approval.id, ["approved"], "expired");
    if (expired) {
      await emit(
        repo,
        { ...base, type: "action.executed", level: "warning", summary: toSummary(`Expired before execution: ${approval.title}`), payload: { approval_id: approval.id, status: "expired" } },
        { agentState: null },
      );
      await settleRun(repo, approval);
    }
    return "expired";
  }

  // Re-check permission at execution time: grants may have changed since the request.
  const agent = await repo.getAgent(approval.agent_id);
  const tool = getTool(approval.action.tool);
  const permission = tool ? await repo.getPermission(approval.agent_id, tool.name) : null;
  const parsed = tool?.schema.safeParse(approval.action.args);
  const refusal = !agent || !agent.enabled
    ? "agent disabled"
    : !tool
      ? `unknown tool ${approval.action.tool}`
      : !permission || !tierAllows(permission.max_tier, tool.tier)
        ? "permission revoked"
        : !parsed?.success
          ? "stored arguments no longer validate"
          : null;
  if (refusal || !agent || !tool || !parsed?.success) {
    const failed = await repo.transitionApproval(approval.id, ["approved"], "failed", { result: { error: refusal } });
    if (failed) {
      await emit(
        repo,
        { ...base, type: "action.executed", level: "error", summary: toSummary(`Not executed (${refusal}): ${approval.title}`), payload: { approval_id: approval.id, error: refusal } },
        { agentState: null },
      );
      await settleRun(repo, approval);
    }
    return "failed";
  }

  // The single claim. A concurrent executor (webhook + sweeper) gets null here.
  const claimed = await repo.transitionApproval(approval.id, ["approved"], "executing");
  if (!claimed) return "already_claimed";

  const started = Date.now();
  const secret = tool.integration === "internal" ? null : await resolveSecret(repo, agent.id, tool.integration);
  try {
    const result = await tool.execute(parsed.data as never, {
      repo,
      agent,
      runId: approval.run_id,
      secret,
      idempotencyKey: approval.id,
      services: deps.services ?? {},
      now,
    });
    await repo.transitionApproval(approval.id, ["executing"], "executed", { result });
    await repo.logToolCall({
      run_id: approval.run_id,
      agent_id: agent.id,
      tool_name: tool.name,
      tier: tool.tier,
      status: "ok",
      args: approval.action.args,
      result: { approval_id: approval.id, result },
      duration_ms: Date.now() - started,
    });
    await emit(
      repo,
      { ...base, type: "action.executed", level: "success", summary: toSummary(`Done: ${approval.title}`), payload: { approval_id: approval.id, tool: tool.name, result } },
      { agentState: null },
    );
    await settleRun(repo, approval);
    return "executed";
  } catch (error) {
    const failure = describeError(error);
    await repo.transitionApproval(approval.id, ["executing"], "failed", { result: failure });
    await repo.logToolCall({
      run_id: approval.run_id,
      agent_id: agent.id,
      tool_name: tool.name,
      tier: tool.tier,
      status: "error",
      args: approval.action.args,
      result: { approval_id: approval.id, ...failure },
      duration_ms: Date.now() - started,
    });
    await emit(
      repo,
      { ...base, type: "action.executed", level: "error", summary: toSummary(`Failed: ${approval.title}`), payload: { approval_id: approval.id, tool: tool.name, error: failure } },
      { agentState: null },
    );
    await settleRun(repo, approval);
    return "failed";
  }
}

/** A run waiting on approvals completes once none of its approvals are open. */
export async function settleRun(repo: Repo, approval: Pick<ApprovalRow, "run_id">): Promise<void> {
  if (!approval.run_id) return;
  const run = await repo.getRun(approval.run_id);
  if (run?.status !== "waiting_approval") return;
  const open = await repo.listApprovals({ runId: approval.run_id, statuses: ["pending", "approved", "executing"], limit: 1 });
  if (open.length === 0) await repo.updateRun(approval.run_id, { status: "succeeded" });
}
