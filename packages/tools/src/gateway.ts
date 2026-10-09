import {
  requiresApproval,
  tierAllows,
  toSummary,
  type AgentRow,
  type RiskTier,
  type ToolCallStatus,
} from "@agent-city/core";
import { emit, type Repo } from "@agent-city/db";
import { z } from "zod";
import { argsSchemaFor, hashAction, RATIONALE_FIELD, resolveSecret } from "./policy";
import { getTool } from "./registry";
import { ToolError, type ToolServices } from "./types";

// The security core (spec §7). Every tool call from every agent goes through
// invoke(): permission check, argument validation, approval gate for
// external/financial effects, scoped secret, execution, audit log.

export interface GatewayContext {
  repo: Repo;
  agent: AgentRow;
  runId: string | null;
  services?: ToolServices;
  now?: () => Date;
}

export type GatewayResult =
  | { error: "unknown_tool"; tool: string }
  | { error: "permission_denied"; tool: string }
  | { error: "invalid_args"; details: unknown }
  | { error: string; message: string }
  | { status: "pending_approval"; approval_id: string; deduplicated: boolean; note: string }
  | { status: "ok"; result: unknown };

const RESULT_LOG_LIMIT = 20_000;

function forLog(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  return text.length <= RESULT_LOG_LIMIT ? value : { truncated: true, preview: text.slice(0, RESULT_LOG_LIMIT) };
}

export async function invoke(ctx: GatewayContext, toolName: string, rawArgs: unknown): Promise<GatewayResult> {
  const { repo, agent, runId } = ctx;
  const started = Date.now();
  const log = (status: ToolCallStatus, tier: RiskTier | null, args: unknown, result: unknown) =>
    repo.logToolCall({
      run_id: runId,
      agent_id: agent.id,
      tool_name: toolName,
      tier,
      status,
      args: forLog(args),
      result: forLog(result),
      duration_ms: Date.now() - started,
    });

  const tool = getTool(toolName);
  if (!tool) {
    await log("denied", null, rawArgs, { error: "unknown_tool" });
    return { error: "unknown_tool", tool: toolName };
  }

  const permission = await repo.getPermission(agent.id, toolName);
  if (!permission || !tierAllows(permission.max_tier, tool.tier)) {
    await emit(
      repo,
      {
        division_id: agent.division_id,
        agent_id: agent.id,
        run_id: runId ?? undefined,
        type: "run.progress",
        level: "warning",
        summary: toSummary(`Denied: ${toolName}`),
        payload: { tool: toolName, tier: tool.tier, granted: permission?.max_tier ?? null },
      },
      { agentState: null },
    );
    await log("denied", tool.tier, rawArgs, { error: "permission_denied" });
    return { error: "permission_denied", tool: toolName };
  }

  const parsed = argsSchemaFor(tool).safeParse(rawArgs);
  if (!parsed.success) {
    const details = z.flattenError(parsed.error);
    await log("invalid", tool.tier, rawArgs, { error: "invalid_args", details });
    return { error: "invalid_args", details };
  }
  const data = parsed.data as Record<string, unknown>;

  if (requiresApproval(tool.tier)) {
    // Side effects never execute here. Store the exact action; Nico decides.
    const { [RATIONALE_FIELD]: rationale, ...args } = data;
    const action = { tool: tool.name, args };
    const amount = tool.amount?.(args as never) ?? null;
    const { approval, created } = await repo.createApproval({
      division_id: agent.division_id,
      agent_id: agent.id,
      run_id: runId,
      tier: tool.tier,
      title: toSummary(tool.describe(args as never)),
      rationale: String(rationale ?? "No rationale provided"),
      action,
      action_hash: hashAction(action),
      amount_cents: amount?.amount_cents ?? null,
      currency: amount?.currency ?? null,
    });
    if (created) {
      await emit(
        repo,
        {
          division_id: agent.division_id,
          agent_id: agent.id,
          run_id: runId ?? undefined,
          type: "approval.requested",
          level: "warning",
          summary: approval.title,
          payload: { approval_id: approval.id, tier: tool.tier, amount_cents: approval.amount_cents },
        },
        { agentState: null },
      );
    }
    await log("pending_approval", tool.tier, args, { approval_id: approval.id, deduplicated: !created });
    return {
      status: "pending_approval",
      approval_id: approval.id,
      deduplicated: !created,
      note: created
        ? "Queued for Nico's approval. If approved it executes exactly as specified. Do not call this tool again for the same action; mention it in your summary."
        : "An identical action is already waiting in the approval queue. Nothing new was queued.",
    };
  }

  const secret = tool.integration === "internal" ? null : await resolveSecret(repo, agent.id, tool.integration);
  try {
    const result = await tool.execute(data as never, {
      repo,
      agent,
      runId,
      secret,
      idempotencyKey: null,
      services: ctx.services ?? {},
      now: ctx.now ?? (() => new Date()),
    });
    await log("ok", tool.tier, data, result);
    return { status: "ok", result };
  } catch (error) {
    const failure = describeError(error);
    await log("error", tool.tier, data, failure);
    return failure;
  }
}

export function describeError(error: unknown): { error: string; message: string } {
  if (error instanceof ToolError) return { error: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { error: "tool_failed", message: message.slice(0, 1_000) };
}
