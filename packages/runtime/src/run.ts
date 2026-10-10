import Anthropic from "@anthropic-ai/sdk";
import { formatUsd, MODELS, toSummary, type RunStatus, type RunTrigger } from "@agent-city/core";
import { emit } from "@agent-city/db";
import { apiToolsFor, invoke, toolFromApiName, type GatewayResult, type ToolServices } from "@agent-city/tools";
import { buildContext, systemPrompt } from "./context";
import { checkBudget, isPaused } from "./guards";
import { buildRequest, textOf, type MessageParam, type ModelMessage } from "./model";
import { addUsage, emptyUsage, PriceBook } from "./pricing";
import type { RuntimeDeps } from "./types";

export const MAX_STEPS = 15;
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_RESULT_LIMIT = 40_000;
const BUSY_WINDOW_MS = 15 * 60 * 1000;

export interface RunRequest {
  agentId: string;
  /** Defaults to the agent's default_goal (scheduled runs). */
  goal?: string | null;
  trigger: RunTrigger;
}

export type RunOutcome =
  | { status: "skipped"; reason: "paused" | "disabled" | "budget" | "busy" | "no_goal" | "not_configured"; message: string }
  | { status: RunStatus; runId: string; summary: string; costUsd: number; steps: number };

class StopRun extends Error {
  constructor(
    readonly kind: "cancelled" | "failed",
    message: string,
  ) {
    super(message);
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `Claude API ${error.status ?? "error"}: ${error.message}`.slice(0, 500);
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function truncate(text: string): string {
  return text.length <= TOOL_RESULT_LIMIT
    ? text
    : `${text.slice(0, TOOL_RESULT_LIMIT)}\n[truncated ${text.length - TOOL_RESULT_LIMIT} characters; narrow the query]`;
}

/**
 * One agent run (spec §6.2): queued -> running -> (waiting_approval) ->
 * succeeded | failed | cancelled. Never throws for run-level failures; they are
 * recorded on the run, emitted as run.failed (red crown) and returned.
 */
export async function runAgent(deps: RuntimeDeps, request: RunRequest): Promise<RunOutcome> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const agent = await repo.getAgent(request.agentId);
  if (!agent) throw new Error(`Unknown agent ${request.agentId}`);

  if (await isPaused(repo)) return { status: "skipped", reason: "paused", message: "The city is paused." };
  if (!agent.enabled) return { status: "skipped", reason: "disabled", message: `${agent.display_name} is disabled.` };
  const goal = (request.goal ?? agent.default_goal ?? "").trim();
  if (!goal) return { status: "skipped", reason: "no_goal", message: `${agent.display_name} has no goal for this run.` };

  const active = await repo.listRuns({ agentId: agent.id, statuses: ["running"], since: new Date(now().getTime() - BUSY_WINDOW_MS), limit: 1 });
  if (active.length > 0) return { status: "skipped", reason: "busy", message: `${agent.display_name} already has a run in progress.` };

  const budget = await checkBudget(repo, agent, now());
  if (!budget.ok) {
    await emit(
      repo,
      {
        division_id: agent.division_id,
        agent_id: agent.id,
        type: "run.progress",
        level: "warning",
        summary: toSummary(`Budget cap: ${budget.message}`),
        payload: { budget_usd: budget.budget, spent_today_usd: budget.spentToday, estimate_usd: budget.estimate },
      },
      { agentState: null },
    );
    return { status: "skipped", reason: "budget", message: budget.message };
  }

  const modelId = MODELS[agent.model_tier];
  const run = await repo.createRun({ agent_id: agent.id, trigger: request.trigger, goal, model: modelId });
  const base = { division_id: agent.division_id, agent_id: agent.id, run_id: run.id };
  await emit(repo, { ...base, type: "run.started", summary: toSummary(goal), payload: { trigger: request.trigger, model: modelId } });

  const maxSteps = deps.maxSteps ?? MAX_STEPS;
  const deadline = Date.now() + (deps.timeoutMs ?? RUN_TIMEOUT_MS);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now()));
  const prices = new PriceBook(repo);
  const usage = emptyUsage();
  let steps = 0;
  let toolCalls = 0;

  const services: ToolServices = {
    ...deps.services,
    // One-shot model calls made inside tools (e.g. fast-model classification) bill to this run.
    complete: async ({ tier, system, prompt, maxTokens }) => {
      const res = await deps.model.create(
        buildRequest({ tier, system, tools: [], messages: [{ role: "user", content: prompt }], maxTokens: maxTokens ?? 4_000 }),
        { signal: abort.signal },
      );
      addUsage(usage, await prices.costOf(res, MODELS[tier]));
      if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
      return textOf(res);
    },
  };

  const permissions = await repo.listPermissions(agent.id);
  const tools = apiToolsFor(permissions.map((p) => p.tool_name)) as Anthropic.Beta.BetaTool[];
  const system = systemPrompt(agent);
  const context = await buildContext(repo, agent, now(), request.trigger);
  // Append-only history: assistant turns go back exactly as received (thinking blocks included).
  const messages: MessageParam[] = [{ role: "user", content: `${context}\n\nGOAL: ${goal}` }];

  const persist = (patch: Parameters<typeof repo.updateRun>[1] = {}) =>
    repo.updateRun(run.id, {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      cost_usd: Number(usage.cost_usd.toFixed(6)),
      transcript: { model: modelId, system, tools: tools.map((t) => t.name), messages },
      ...patch,
    });

  const finish = async (text: string): Promise<RunOutcome> => {
    const openForRun = await repo.listApprovals({ runId: run.id, statuses: ["pending", "approved", "executing"] });
    const status: RunStatus = openForRun.length > 0 ? "waiting_approval" : "succeeded";
    await persist({ status, ended_at: now() });
    const waiting = (await repo.countPendingApprovals(agent.id)) > 0;
    const firstLine = (text.split("\n").find((l) => l.trim()) ?? "Run complete").replace(/^[#>*\-\s]+/, "").trim() || "Run complete";
    await emit(
      repo,
      {
        ...base,
        type: "run.succeeded",
        level: "success",
        summary: toSummary(firstLine),
        payload: {
          output: text.slice(0, 4_000),
          run_status: status,
          approvals_pending: openForRun.length,
          cost_usd: Number(usage.cost_usd.toFixed(4)),
          steps,
          tool_calls: toolCalls,
        },
      },
      { agentState: waiting ? "waiting_approval" : "idle" },
    );
    return { status, runId: run.id, summary: firstLine, costUsd: usage.cost_usd, steps };
  };

  try {
    for (;;) {
      if (steps >= maxSteps) throw new StopRun("failed", `max steps exceeded (${maxSteps})`);
      if (Date.now() >= deadline) throw new StopRun("failed", "run timed out after 10 minutes");
      if (await isPaused(repo)) throw new StopRun("cancelled", "the city was paused");
      steps++;

      const response: ModelMessage = await deps.model.create(buildRequest({ tier: agent.model_tier, system, tools, messages }), {
        signal: abort.signal,
      });
      addUsage(usage, await prices.costOf(response, modelId));
      messages.push({ role: "assistant", content: response.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
      await persist();

      if (budget.spentToday + usage.cost_usd > agent.daily_budget_usd) {
        throw new StopRun("cancelled", `daily budget of ${formatUsd(agent.daily_budget_usd)} reached mid-run`);
      }

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      switch (response.stop_reason) {
        case "end_turn":
        case "stop_sequence":
          return await finish(textOf(response));
        case "pause_turn":
          continue;
        case "refusal":
          throw new StopRun("failed", `the model declined (${response.stop_details?.category ?? "no category"})`);
        case "tool_use":
        case "max_tokens": {
          const truncated = response.stop_reason === "max_tokens";
          if (toolUses.length === 0) {
            // Cut off mid-answer with nothing to run: ask for the rest once more.
            messages.push({ role: "user", content: "Your last message hit the output limit. Finish concisely." });
            continue;
          }
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const block of toolUses) {
            toolCalls++;
            let result: GatewayResult | { error: string; message: string };
            if (truncated) {
              // Never run a tool whose input may have been cut off.
              result = { error: "truncated", message: "Your tool input was cut off at the output limit. Send it again, shorter." };
            } else {
              const tool = toolFromApiName(block.name);
              result = tool
                ? await invoke({ repo, agent, runId: run.id, services, now }, tool.name, block.input)
                : { error: "unknown_tool", tool: block.name };
            }
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: truncate(JSON.stringify(result)),
              is_error: "error" in result,
            });
          }
          // All results for one assistant turn go back in a single user message.
          messages.push({ role: "user", content: results });
          continue;
        }
        default:
          throw new StopRun("failed", `stopped: ${response.stop_reason ?? "unknown reason"}`);
      }
    }
  } catch (error) {
    if (error instanceof StopRun && error.kind === "cancelled") {
      await persist({ status: "cancelled", ended_at: now(), error: error.message });
      await emit(repo, { ...base, type: "run.progress", level: "warning", summary: toSummary(`Stopped: ${error.message}`) }, { agentState: "idle" });
      return { status: "cancelled", runId: run.id, summary: error.message, costUsd: usage.cost_usd, steps };
    }
    const message = abort.signal.aborted ? "run timed out after 10 minutes" : describeFailure(error);
    await persist({ status: "failed", ended_at: now(), error: message });
    await emit(
      repo,
      { ...base, type: "run.failed", level: "error", summary: toSummary(`Failed: ${message}`), payload: { error: message, steps, tool_calls: toolCalls } },
      { agentState: "error" },
    );
    return { status: "failed", runId: run.id, summary: message, costUsd: usage.cost_usd, steps };
  } finally {
    clearTimeout(timer);
  }
}
