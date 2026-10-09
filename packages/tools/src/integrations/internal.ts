import { MetricValue, TASK_STATUSES, toSummary, type TaskRow } from "@agent-city/core";
import { emit } from "@agent-city/db";
import { z } from "zod";
import { defineTool, ToolError, type ToolContext } from "../types";

// Internal tools touch only Agent City's own tables. They execute immediately
// (tiers read / internal_write) and every call is still logged by the gateway.

const TaskStatus = z.enum(TASK_STATUSES);

/** Division agents work inside their own division; HQ works across all of them. */
export function assertDivisionScope(ctx: ToolContext, divisionId: string): void {
  if (ctx.agent.division_id !== "hq" && ctx.agent.division_id !== divisionId) {
    throw new ToolError("out_of_scope", `${ctx.agent.display_name} can only act on division "${ctx.agent.division_id}".`);
  }
}

function compactTask(t: TaskRow) {
  return {
    id: t.id,
    division_id: t.division_id,
    title: t.title,
    notes: t.notes,
    owner: t.owner,
    status: t.status,
    priority: t.priority,
    due_at: t.due_at,
    source: t.source,
    updated_at: t.updated_at,
  };
}

export const taskList = defineTool({
  name: "task.list",
  tier: "read",
  integration: "internal",
  description:
    "List tasks, highest priority first. Defaults to open, in_progress and blocked tasks across every division.",
  schema: z.object({
    division_id: z.string().optional().describe("Only tasks for this division id"),
    statuses: z.array(TaskStatus).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  describe: (a) => `List tasks${a.division_id ? ` for ${a.division_id}` : ""}`,
  async execute(a, ctx) {
    const tasks = await ctx.repo.listTasks({
      divisionId: a.division_id,
      statuses: a.statuses ?? ["open", "in_progress", "blocked"],
      limit: a.limit ?? 50,
    });
    return { tasks: tasks.map(compactTask) };
  },
});

export const taskCreate = defineTool({
  name: "task.create",
  tier: "internal_write",
  integration: "internal",
  description:
    "Create a task for Nico (owner 'nico', the default) or for an agent (owner = agent id). Use for follow-ups, decisions Nico must make, and proposed experiments. Keep titles short and specific; put detail in notes.",
  schema: z.object({
    division_id: z.string(),
    title: z.string().min(3).max(140),
    notes: z.string().max(4000).optional(),
    priority: z.number().int().min(1).max(5).optional().describe("1 = highest, default 3"),
    owner: z.string().max(64).optional(),
    due_at: z.iso.datetime({ offset: true }).optional(),
  }),
  describe: (a) => `Create task "${a.title}" in ${a.division_id}`,
  async execute(a, ctx) {
    assertDivisionScope(ctx, a.division_id);
    const task = await ctx.repo.createTask({
      division_id: a.division_id,
      title: a.title,
      notes: a.notes ?? null,
      priority: a.priority,
      owner: a.owner,
      due_at: a.due_at ? new Date(a.due_at) : null,
      source: ctx.agent.id,
    });
    await emit(ctx.repo, {
      division_id: a.division_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId ?? undefined,
      type: "task.created",
      summary: toSummary(`New task: ${a.title}`),
      payload: { task_id: task.id, priority: task.priority, owner: task.owner },
    });
    return { task_id: task.id, status: task.status };
  },
});

export const taskUpdate = defineTool({
  name: "task.update",
  tier: "internal_write",
  integration: "internal",
  description: "Update a task's status, priority, owner, title or notes.",
  schema: z.object({
    task_id: z.uuid(),
    status: TaskStatus.optional(),
    priority: z.number().int().min(1).max(5).optional(),
    owner: z.string().max(64).optional(),
    title: z.string().min(3).max(140).optional(),
    notes: z.string().max(4000).optional(),
  }),
  describe: (a) => `Update task ${a.task_id}${a.status ? ` -> ${a.status}` : ""}`,
  async execute(a, ctx) {
    const existing = await ctx.repo.getTask(a.task_id);
    if (!existing) throw new ToolError("not_found", `No task ${a.task_id}.`);
    assertDivisionScope(ctx, existing.division_id);
    const task = await ctx.repo.updateTask(a.task_id, {
      status: a.status,
      priority: a.priority,
      owner: a.owner,
      title: a.title,
      notes: a.notes,
    });
    await emit(ctx.repo, {
      division_id: existing.division_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId ?? undefined,
      type: "task.updated",
      summary: toSummary(`Task ${a.status ? a.status.replace("_", " ") : "updated"}: ${task?.title ?? existing.title}`),
      payload: { task_id: a.task_id, status: task?.status, priority: task?.priority },
    });
    return { task: task ? compactTask(task) : null };
  },
});

export const metricRecord = defineTool({
  name: "metric.record",
  tier: "internal_write",
  integration: "internal",
  description:
    "Record the latest values of division metrics (e.g. mrr, active_subscriptions, signups_7d). Keys are snake_case. The city shows them on the division's building. Only record numbers you computed from tool results.",
  schema: z.object({
    metrics: z
      .record(z.string().regex(/^[a-z0-9_]{1,40}$/), MetricValue)
      .refine((m) => Object.keys(m).length > 0 && Object.keys(m).length <= 20, "1 to 20 metrics"),
    summary: z.string().min(3).max(200).describe("One line for the activity log, e.g. 'MRR $4,210 (+3.1% WoW)'"),
  }),
  describe: (a) => a.summary,
  async execute(a, ctx) {
    const asOf = ctx.now().toISOString();
    const metrics = Object.fromEntries(Object.entries(a.metrics).map(([k, v]) => [k, { ...v, as_of: v.as_of ?? asOf }]));
    const event = await emit(ctx.repo, {
      division_id: ctx.agent.division_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId ?? undefined,
      type: "metric.updated",
      level: "info",
      summary: toSummary(a.summary),
      payload: { metrics },
    });
    return { recorded: Object.keys(metrics), event_id: event.id };
  },
});

export const eventsRecent = defineTool({
  name: "events.recent",
  tier: "read",
  integration: "internal",
  description: "Read recent activity events, newest first.",
  schema: z.object({
    division_id: z.string().optional(),
    hours: z.number().int().min(1).max(168).optional().describe("Look-back window, default 24"),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  describe: (a) => `Read events${a.division_id ? ` for ${a.division_id}` : ""}`,
  async execute(a, ctx) {
    const since = new Date(ctx.now().getTime() - (a.hours ?? 24) * 3_600_000);
    const events = await ctx.repo.listEvents({ divisionId: a.division_id, since, limit: a.limit ?? 100 });
    return {
      events: events.map((e) => ({
        ts: e.ts,
        division_id: e.division_id,
        agent_id: e.agent_id,
        type: e.type,
        level: e.level,
        summary: e.summary,
      })),
    };
  },
});

export const divisionUpdateContext = defineTool({
  name: "division.update_context",
  tier: "internal_write",
  integration: "internal",
  description:
    "Replace a division's living context document (markdown). Agents read it at the start of every run, so keep it short, current and factual. Read the current version in your run context first and preserve what is still true.",
  schema: z.object({
    division_id: z.string(),
    context_md: z.string().min(10).max(20_000),
  }),
  describe: (a) => `Update ${a.division_id} context doc`,
  async execute(a, ctx) {
    assertDivisionScope(ctx, a.division_id);
    const ok = await ctx.repo.updateDivisionContext(a.division_id, a.context_md);
    if (!ok) throw new ToolError("not_found", `No division ${a.division_id}.`);
    return { updated: true };
  },
});

export const INTERNAL_TOOLS = [taskList, taskCreate, taskUpdate, metricRecord, eventsRecent, divisionUpdateContext];
