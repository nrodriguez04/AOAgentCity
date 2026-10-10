import {
  computeCostUsd,
  DEFAULT_RUN_COST_ESTIMATE_USD,
  MODELS,
  parseCrewOutput,
  toSummary,
  type AgentRow,
  type CrewConnection,
  type CrewIO,
  type CrewResult,
  type CrewSpec,
  type CrewUsage,
  type ModelPricingRow,
} from "@agent-city/core";
import { emit } from "@agent-city/db";
import { invoke, resolveSecret, type GatewayContext, type GatewayResult } from "@agent-city/tools";
import { checkBudget, isPaused } from "./guards";
import { emptyUsage, PriceBook, type UsageTotals } from "./pricing";
import type { RunOutcome, RunRequest } from "./run";
import type { RuntimeDeps } from "./types";

// CrewAI crews run on CrewAI AMP; Agent City owns everything around them. A
// crew run checks the same guards as an agent run (pause, budget, one run at a
// time), builds the crew's inputs through read tools, starts the crew, follows
// its tasks so the city lights up as each member works, then validates the
// crew's JSON result and applies it through the tool gateway with the crew's
// own grants. Crews never hold database credentials.

export const CREW_POLL_MS = 15_000;
export const CREW_TIMEOUT_MS = 30 * 60 * 1000;
const CREW_BUSY_WINDOW_MS = 45 * 60 * 1000;
const MAX_STATUS_FAILURES = 5;

// ------------------------------------------------------------- AMP client

export interface CrewTaskOutput {
  taskId: string;
  agent: string | null;
  output: string;
  executionTime: number | null;
}

export type CrewStatus =
  | { state: "running"; currentTask: string | null; completedTasks: number | null; totalTasks: number | null }
  | { state: "completed"; output: string; tasks: CrewTaskOutput[]; executionTime: number | null }
  | { state: "error"; error: string; executionTime: number | null };

export interface CrewClient {
  /** Starts the crew and returns its kickoff id. */
  kickoff(connection: CrewConnection, body: { inputs: Record<string, string>; meta?: Record<string, unknown> }): Promise<string>;
  status(connection: CrewConnection, kickoffId: string): Promise<CrewStatus>;
}

export class CrewApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CrewApiError";
  }
}

type Json = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

/** CrewAI AMP's deployed-crew API: POST /kickoff, then GET /status/{kickoff_id}. */
export function ampCrewClient(fetchImpl: typeof fetch = fetch): CrewClient {
  const request = async (connection: CrewConnection, path: string, init?: RequestInit): Promise<Json> => {
    const base = connection.url.endsWith("/") ? connection.url : `${connection.url}/`;
    const res = await fetchImpl(new URL(path, base), {
      ...init,
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json" },
    });
    const body = await res.text();
    if (!res.ok) throw new CrewApiError(res.status, `CrewAI AMP returned ${res.status}: ${body.slice(0, 300)}`);
    try {
      return JSON.parse(body) as Json;
    } catch {
      throw new CrewApiError(res.status, `CrewAI AMP returned something that is not JSON: ${body.slice(0, 200)}`);
    }
  };
  return {
    async kickoff(connection, body) {
      const data = await request(connection, "kickoff", { method: "POST", body: JSON.stringify(body) });
      const id = data.kickoff_id ?? data.id;
      if (typeof id !== "string" || id.length === 0) throw new CrewApiError(200, "CrewAI AMP did not return a kickoff_id");
      return id;
    },
    async status(connection, kickoffId) {
      return normalizeCrewStatus(await request(connection, `status/${encodeURIComponent(kickoffId)}`));
    },
  };
}

/** Maps AMP's status payload (running / completed / error) to a CrewStatus. */
export function normalizeCrewStatus(raw: unknown): CrewStatus {
  const r = (raw ?? {}) as Json;
  const state = String(r.status ?? r.state ?? "").toLowerCase();
  if (["completed", "complete", "success", "succeeded", "finished", "done"].includes(state)) {
    const result = r.result;
    const resultObj = (result && typeof result === "object" ? result : {}) as Json;
    const output = typeof result === "string" ? result : text(resultObj.output ?? resultObj.raw ?? result);
    const tasks = Array.isArray(resultObj.tasks)
      ? (resultObj.tasks as Json[]).map((t) => ({
          taskId: String(t.task_id ?? t.name ?? ""),
          agent: typeof t.agent === "string" ? t.agent : null,
          output: text(t.output),
          executionTime: numOrNull(t.execution_time),
        }))
      : [];
    return { state: "completed", output, tasks, executionTime: numOrNull(r.execution_time) };
  }
  if (["error", "failed", "failure", "cancelled", "canceled"].includes(state)) {
    return { state: "error", error: String(r.error ?? r.message ?? `the crew ended with status ${state}`).slice(0, 1_000), executionTime: numOrNull(r.execution_time) };
  }
  const progress = (r.progress ?? {}) as Json;
  return {
    state: "running",
    currentTask: typeof r.current_task === "string" && r.current_task ? r.current_task : null,
    completedTasks: numOrNull(progress.completed_tasks),
    totalTasks: numOrNull(progress.total_tasks),
  };
}

/** Reads the crew's deployment from its Vault secret: {"url": "https://<crew>.crewai.com", "token": "..."}. */
export function parseCrewConnection(secret: string | null): CrewConnection | null {
  if (!secret) return null;
  try {
    const value = JSON.parse(secret) as Partial<CrewConnection>;
    const url = typeof value.url === "string" ? value.url.trim() : "";
    const secure = /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
    if (secure && typeof value.token === "string" && value.token.length > 0) return { url, token: value.token };
  } catch {
    // Not JSON: treated as missing.
  }
  return null;
}

// ------------------------------------------------------------- crew runs

export interface CrewRuntimeDeps extends RuntimeDeps {
  crewClient: CrewClient;
  /** Waits between status polls. The worker passes Trigger.dev's wait.for so a long crew does not hold a machine. */
  sleep?(ms: number): Promise<void>;
  crewPollMs?: number;
  crewTimeoutMs?: number;
}

class CrewStop extends Error {
  constructor(
    readonly kind: "cancelled" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max)} [${value.length - max} more characters]`);

/** Which of the crew's tasks is running, from AMP's current_task or its progress count. */
export function currentTaskIndex(crew: CrewSpec, status: Extract<CrewStatus, { state: "running" }>): number | null {
  if (status.currentTask) {
    const name = status.currentTask.toLowerCase();
    const byId = crew.tasks.findIndex((t) => t.id === status.currentTask || name.includes(t.id.toLowerCase()));
    if (byId >= 0) return byId;
  }
  if (status.completedTasks !== null) return Math.min(Math.max(0, status.completedTasks), crew.tasks.length - 1);
  return null;
}

/**
 * Cost of a crew run from the usage it reports. Crews may mix models, so the
 * run is priced at the most expensive one it used (budgets stay safe). Long
 * context rates are decided per request, not on the run's total.
 */
export async function crewCost(prices: PriceBook, usage: CrewUsage | null | undefined, agent: AgentRow): Promise<{ totals: UsageTotals; estimated: boolean; model: string }> {
  if (!usage || usage.prompt_tokens + usage.completion_tokens === 0) {
    return { totals: { ...emptyUsage(), cost_usd: DEFAULT_RUN_COST_ESTIMATE_USD[agent.model_tier] }, estimated: true, model: "crewai" };
  }
  const models = usage.models.map((m) => m.replace(/^anthropic\//, "")).filter(Boolean);
  const candidates = models.length > 0 ? [...new Set(models)] : [MODELS[agent.model_tier]];
  let pricing: ModelPricingRow | null = null;
  for (const model of candidates) {
    const p = await prices.get(model);
    if (!pricing || p.output_per_mtok > pricing.output_per_mtok) pricing = p;
  }
  const cacheRead = usage.cached_prompt_tokens;
  const cacheWrite = usage.cache_creation_tokens;
  const input = Math.max(0, usage.prompt_tokens - cacheRead - cacheWrite);
  const requests = Math.max(1, usage.successful_requests);
  const perRequest = computeCostUsd(pricing!, {
    input_tokens: input / requests,
    output_tokens: usage.completion_tokens / requests,
    cache_read_input_tokens: cacheRead / requests,
    cache_creation_input_tokens: cacheWrite / requests,
    cache_creation: null,
  });
  return {
    totals: { input_tokens: input, output_tokens: usage.completion_tokens, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, cost_usd: perRequest * requests },
    estimated: false,
    model: candidates.join(","),
  };
}

function describeGatewayFailure(result: GatewayResult): string {
  if ("message" in result) return `${result.error}: ${result.message}`;
  if ("details" in result) return `invalid_args: ${JSON.stringify(result.details).slice(0, 300)}`;
  if ("tool" in result) return `${result.error} (${result.tool})`;
  return JSON.stringify(result).slice(0, 300);
}

export interface AppliedCrewResult {
  drafts: string[];
  tasks: string[];
  metrics: string[];
  errors: { tool: string; error: string }[];
}

/** Saves a crew's drafts, tasks and metrics through the gateway, as the crew. */
export async function applyCrewResult(ctx: GatewayContext, result: CrewResult, now: () => Date): Promise<AppliedCrewResult> {
  const applied: AppliedCrewResult = { drafts: [], tasks: [], metrics: [], errors: [] };
  const record = (tool: string, r: GatewayResult, onOk: (value: Record<string, unknown>) => void) => {
    if ("status" in r && r.status === "ok") onOk((r.result ?? {}) as Record<string, unknown>);
    else applied.errors.push({ tool, error: describeGatewayFailure(r) });
  };

  for (const d of result.drafts) {
    const r = await invoke(ctx, "draft.save", { kind: d.kind, channel: d.channel ?? undefined, title: d.title, body_md: d.body_md });
    record("draft.save", r, (v) => applied.drafts.push(String(v.draft_id)));
  }
  for (const t of result.tasks) {
    const due = t.due_in_days != null ? new Date(now().getTime() + t.due_in_days * 86_400_000).toISOString() : undefined;
    const r = await invoke(ctx, "task.create", {
      division_id: ctx.agent.division_id,
      title: t.title,
      notes: t.notes ?? undefined,
      priority: t.priority ?? undefined,
      due_at: due,
    });
    record("task.create", r, (v) => applied.tasks.push(String(v.task_id)));
  }
  if (result.metrics && Object.keys(result.metrics).length > 0) {
    const r = await invoke(ctx, "metric.record", { metrics: result.metrics, summary: result.metrics_summary ?? result.summary.slice(0, 200) });
    record("metric.record", r, (v) => applied.metrics.push(...((v.recorded as string[]) ?? [])));
  }
  return applied;
}

/**
 * One crew run: queued -> running -> succeeded | failed | cancelled, recorded
 * and emitted exactly like an agent run. Never throws for run-level failures.
 */
export async function runCrew(deps: CrewRuntimeDeps, request: RunRequest, crew: CrewSpec): Promise<RunOutcome> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const agent = await repo.getAgent(request.agentId);
  if (!agent) throw new Error(`Unknown agent ${request.agentId}`);
  if (agent.runtime !== "crewai") throw new Error(`${agent.id} is not a crew (runtime ${agent.runtime})`);

  if (await isPaused(repo)) return { status: "skipped", reason: "paused", message: "The city is paused." };
  if (!agent.enabled) return { status: "skipped", reason: "disabled", message: `${agent.display_name} is disabled.` };
  const goal = (request.goal ?? agent.default_goal ?? "").trim();
  if (!goal) return { status: "skipped", reason: "no_goal", message: `${agent.display_name} has no goal for this run.` };

  const active = await repo.listRuns({ agentId: agent.id, statuses: ["running"], since: new Date(now().getTime() - CREW_BUSY_WINDOW_MS), limit: 1 });
  if (active.length > 0) return { status: "skipped", reason: "busy", message: `${agent.display_name} already has a run in progress.` };

  const base = { division_id: agent.division_id, agent_id: agent.id };
  const budget = await checkBudget(repo, agent, now());
  if (!budget.ok) {
    await emit(
      repo,
      {
        ...base,
        type: "run.progress",
        level: "warning",
        summary: toSummary(`Budget cap: ${budget.message}`),
        payload: { budget_usd: budget.budget, spent_today_usd: budget.spentToday, estimate_usd: budget.estimate },
      },
      { agentState: null },
    );
    return { status: "skipped", reason: "budget", message: budget.message };
  }

  const connection = parseCrewConnection(await resolveSecret(repo, agent.id, "crewai"));
  if (!connection) {
    const message = `${agent.display_name} is not connected to CrewAI AMP yet: store {"url","token"} in Vault as agent:${agent.id}:crewai.`;
    await emit(repo, { ...base, type: "run.progress", level: "warning", summary: toSummary(message), payload: { project: crew.project } }, { agentState: null });
    return { status: "skipped", reason: "not_configured", message };
  }

  const run = await repo.createRun({ agent_id: agent.id, trigger: request.trigger, goal, model: "crewai", parent_run_id: request.parentRunId });
  const inRun = { ...base, run_id: run.id };
  await emit(repo, { ...inRun, type: "run.started", summary: toSummary(goal), payload: { trigger: request.trigger, runtime: "crewai", project: crew.project } });

  const transcript: Record<string, unknown> = { runtime: "crewai", project: crew.project };
  let usage = emptyUsage();
  let model = "crewai";
  const persist = (patch: Parameters<typeof repo.updateRun>[1] = {}) =>
    repo.updateRun(run.id, {
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      cost_usd: Number(usage.cost_usd.toFixed(6)),
      transcript,
      ...patch,
    });
  const gateway: GatewayContext = { repo, agent, runId: run.id, services: deps.services ?? {}, now };
  const io: CrewIO = {
    agent,
    now,
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      const result = await invoke(gateway, tool, args);
      if ("status" in result && result.status === "ok") return result.result as T;
      throw new CrewStop("failed", `${tool} failed while preparing the crew: ${describeGatewayFailure(result)}`);
    },
  };

  try {
    const prepared = await crew.buildInputs(io);
    if ("skip" in prepared) {
      transcript.skipped = prepared.skip;
      await persist({ status: "succeeded", ended_at: now() });
      await emit(
        repo,
        { ...inRun, type: "run.succeeded", level: "success", summary: toSummary(prepared.skip), payload: { skipped: true, cost_usd: 0 } },
        { agentState: "idle" },
      );
      return { status: "succeeded", runId: run.id, summary: prepared.skip, costUsd: 0, steps: 0 };
    }

    const inputs = { goal, ...prepared.inputs };
    transcript.inputs = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, clip(v, 4_000)]));
    const kickoffId = await deps.crewClient.kickoff(connection, { inputs, meta: { agent_id: agent.id, run_id: run.id } });
    transcript.kickoff_id = kickoffId;
    await persist();

    const timeoutMs = deps.crewTimeoutMs ?? CREW_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastTask = -1;
    let failures = 0;
    let status: CrewStatus;
    for (;;) {
      await sleep(deps.crewPollMs ?? CREW_POLL_MS);
      if (await isPaused(repo)) throw new CrewStop("cancelled", "the city was paused; the crew may still finish on CrewAI, but its result will not be applied");
      try {
        status = await deps.crewClient.status(connection, kickoffId);
        failures = 0;
      } catch (error) {
        if (++failures >= MAX_STATUS_FAILURES) throw new CrewStop("failed", `lost track of the crew: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (status.state !== "running") break;
      const index = currentTaskIndex(crew, status);
      if (index !== null && index !== lastTask) {
        lastTask = index;
        const task = crew.tasks[index]!;
        await emit(repo, {
          ...inRun,
          type: "run.progress",
          summary: toSummary(`${task.member}: ${task.label} (${index + 1}/${crew.tasks.length})`),
          payload: { task_id: task.id, member: task.member, step: index + 1, steps: crew.tasks.length },
        });
      }
      if (Date.now() >= deadline) throw new CrewStop("failed", `the crew did not finish within ${Math.round(timeoutMs / 60_000)} minutes`);
    }
    if (status.state === "error") throw new CrewStop("failed", `the crew failed on CrewAI: ${status.error}`);

    transcript.result = {
      output: clip(status.output, 40_000),
      execution_time: status.executionTime,
      tasks: status.tasks.map((t) => ({ ...t, output: clip(t.output, 4_000) })),
    };
    const parsed = parseCrewOutput(status.output);
    if (!parsed.ok) throw new CrewStop("failed", `the crew's result was not valid: ${parsed.error}`);

    const cost = await crewCost(new PriceBook(repo), parsed.result.usage, agent);
    usage = cost.totals;
    model = cost.model;
    transcript.usage = parsed.result.usage ?? null;
    transcript.cost_estimated = cost.estimated;

    const applied = await applyCrewResult(gateway, parsed.result, now);
    transcript.applied = applied;
    if (applied.errors.length > 0) {
      await emit(
        repo,
        {
          ...inRun,
          type: "run.progress",
          level: "warning",
          summary: toSummary(`${applied.errors.length} of the crew's outputs could not be saved: ${applied.errors[0]!.error}`),
          payload: { errors: applied.errors.slice(0, 10) },
        },
        { agentState: null },
      );
    }

    await persist({ status: "succeeded", ended_at: now() });
    await emit(
      repo,
      {
        ...inRun,
        type: "run.succeeded",
        level: "success",
        summary: toSummary(parsed.result.summary),
        payload: {
          drafts: applied.drafts.length,
          tasks: applied.tasks.length,
          metrics: applied.metrics.length,
          save_errors: applied.errors.length,
          cost_usd: Number(usage.cost_usd.toFixed(4)),
          cost_estimated: cost.estimated,
          execution_time: status.executionTime,
          kickoff_id: kickoffId,
        },
      },
      { agentState: "idle" },
    );
    return { status: "succeeded", runId: run.id, summary: parsed.result.summary, costUsd: usage.cost_usd, steps: crew.tasks.length };
  } catch (error) {
    if (error instanceof CrewStop && error.kind === "cancelled") {
      await persist({ status: "cancelled", ended_at: now(), error: error.message });
      await emit(repo, { ...inRun, type: "run.progress", level: "warning", summary: toSummary(`Stopped: ${error.message}`) }, { agentState: "idle" });
      return { status: "cancelled", runId: run.id, summary: error.message, costUsd: usage.cost_usd, steps: 0 };
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await persist({ status: "failed", ended_at: now(), error: message });
    await emit(repo, { ...inRun, type: "run.failed", level: "error", summary: toSummary(`Failed: ${message}`), payload: { error: message } }, { agentState: "error" });
    return { status: "failed", runId: run.id, summary: message, costUsd: usage.cost_usd, steps: 0 };
  }
}
