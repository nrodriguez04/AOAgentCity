import { APPROVAL_STATUSES, RUN_STATUSES, startOfDayInZone, toSummary } from "@agent-city/core";
import { emit } from "@agent-city/db";
import { z } from "zod";
import { defineTool, ToolError } from "../types";

// HQ reads across every table and decides what matters. It can create and update
// tasks, dispatch division runs and flag stale divisions; it has no tool with an
// external side effect (spec §6.3).

export const divisionsList = defineTool({
  name: "divisions.list",
  tier: "read",
  integration: "internal",
  description:
    "Every division with status, metrics, agents (state, last check-in, schedule), pending approval count, open task count and the time of its latest event.",
  schema: z.object({}),
  describe: () => "List divisions",
  async execute(_a, ctx) {
    const [divisions, agents, pending, tasks] = await Promise.all([
      ctx.repo.listDivisions(),
      ctx.repo.listAgents(),
      ctx.repo.listApprovals({ statuses: ["pending"], limit: 500 }),
      ctx.repo.listTasks({ statuses: ["open", "in_progress", "blocked"], limit: 500 }),
    ]);
    const lastEvents = await Promise.all(divisions.map((d) => ctx.repo.listEvents({ divisionId: d.id, limit: 1 })));
    return {
      divisions: divisions.map((d, i) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        status: d.status,
        summary: d.summary,
        metrics: d.metrics,
        last_event_at: lastEvents[i]?.[0]?.ts ?? null,
        pending_approvals: pending.filter((p) => p.division_id === d.id).length,
        open_tasks: tasks.filter((t) => t.division_id === d.id).length,
        agents: agents
          .filter((a) => a.division_id === d.id)
          .map((a) => ({
            id: a.id,
            display_name: a.display_name,
            role: a.role,
            state: a.state,
            enabled: a.enabled,
            schedule_cron: a.schedule_cron,
            last_checkin_at: a.last_checkin_at,
          })),
      })),
    };
  },
});

export const runsRecent = defineTool({
  name: "runs.recent",
  tier: "read",
  integration: "internal",
  description: "Recent agent runs with status, goal, cost and error (no transcripts). Use statuses ['failed'] to find failures.",
  schema: z.object({
    hours: z.number().int().min(1).max(168).optional().describe("Look-back window, default 24"),
    statuses: z.array(z.enum(RUN_STATUSES)).optional(),
    agent_id: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  describe: (a) => `List runs${a.statuses ? ` (${a.statuses.join(", ")})` : ""}`,
  async execute(a, ctx) {
    const since = new Date(ctx.now().getTime() - (a.hours ?? 24) * 3_600_000);
    const runs = await ctx.repo.listRuns({ agentId: a.agent_id, statuses: a.statuses, since, limit: a.limit ?? 100 });
    return {
      runs: runs.map((r) => ({
        id: r.id,
        agent_id: r.agent_id,
        trigger: r.trigger,
        status: r.status,
        goal: r.goal,
        cost_usd: r.cost_usd,
        error: r.error,
        started_at: r.started_at,
        ended_at: r.ended_at,
      })),
    };
  },
});

export const approvalsList = defineTool({
  name: "approvals.list",
  tier: "read",
  integration: "internal",
  description: "Approvals in the queue. Defaults to pending ones, newest first.",
  schema: z.object({
    statuses: z.array(z.enum(APPROVAL_STATUSES)).optional(),
    division_id: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  describe: () => "List approvals",
  async execute(a, ctx) {
    const approvals = await ctx.repo.listApprovals({
      statuses: a.statuses ?? ["pending"],
      divisionId: a.division_id,
      limit: a.limit ?? 50,
    });
    return {
      approvals: approvals.map((p) => ({
        id: p.id,
        division_id: p.division_id,
        agent_id: p.agent_id,
        tier: p.tier,
        title: p.title,
        amount_cents: p.amount_cents,
        currency: p.currency,
        status: p.status,
        created_at: p.created_at,
        expires_at: p.expires_at,
      })),
    };
  },
});

export const spendSummary = defineTool({
  name: "spend.summary",
  tier: "read",
  integration: "internal",
  description: "Model spend by division for today, yesterday or the last 7 days (America/Chicago days).",
  schema: z.object({ period: z.enum(["today", "yesterday", "last_7_days"]) }),
  describe: (a) => `Spend for ${a.period}`,
  async execute(a, ctx) {
    const todayStart = startOfDayInZone(ctx.now());
    const day = 86_400_000;
    // DST-safe enough for reporting: re-anchor the day boundary after stepping back.
    const yesterdayStart = startOfDayInZone(new Date(todayStart.getTime() - day / 2));
    const weekStart = startOfDayInZone(new Date(todayStart.getTime() - 6 * day + day / 2));
    const [since, until] =
      a.period === "today" ? [todayStart, undefined] : a.period === "yesterday" ? [yesterdayStart, todayStart] : [weekStart, undefined];
    const rows = await ctx.repo.spendByDivision(since, until);
    const total = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    return {
      period: a.period,
      from: since.toISOString(),
      to: (until ?? ctx.now()).toISOString(),
      total_usd: Number(total.toFixed(4)),
      by_division: rows,
    };
  },
});

export const hqDispatchRun = defineTool({
  name: "hq.dispatch_run",
  tier: "internal_write",
  integration: "internal",
  description:
    "Queue a run for a division agent with a specific goal. The run happens asynchronously; you will not see its result in this run. Do not dispatch an agent that already ran on the same goal today unless something changed.",
  schema: z.object({
    agent_id: z.string().describe("e.g. parlaylab.billing-01"),
    goal: z.string().min(10).max(600),
  }),
  describe: (a) => `Dispatch ${a.agent_id}: ${a.goal}`,
  async execute(a, ctx) {
    if (a.agent_id === ctx.agent.id) throw new ToolError("invalid", "HQ cannot dispatch itself.");
    const target = await ctx.repo.getAgent(a.agent_id);
    if (!target) throw new ToolError("not_found", `No agent ${a.agent_id}.`);
    if (!target.enabled) throw new ToolError("disabled", `${target.display_name} is disabled.`);
    if (!ctx.services.dispatchRun) throw new ToolError("unavailable", "Dispatch is not available in this environment.");
    const handle = await ctx.services.dispatchRun({ agentId: a.agent_id, goal: a.goal });
    await emit(ctx.repo, {
      division_id: target.division_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId ?? undefined,
      type: "run.progress",
      summary: toSummary(`HQ dispatched ${target.display_name}: ${a.goal}`),
      payload: { dispatched_agent_id: a.agent_id, handle: handle.id },
    }, { agentState: null });
    return { dispatched: true, handle: handle.id };
  },
});

export const hqFlagStale = defineTool({
  name: "hq.flag_stale",
  tier: "internal_write",
  integration: "internal",
  description: "Flag a division as stale (no meaningful progress). Shows a warning in that division's activity log.",
  schema: z.object({
    division_id: z.string(),
    reason: z.string().min(5).max(300),
  }),
  describe: (a) => `Flag ${a.division_id} stale`,
  async execute(a, ctx) {
    const division = await ctx.repo.getDivision(a.division_id);
    if (!division) throw new ToolError("not_found", `No division ${a.division_id}.`);
    await emit(ctx.repo, {
      division_id: a.division_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId ?? undefined,
      type: "run.progress",
      level: "warning",
      summary: toSummary(`Stale: ${a.reason}`),
      payload: { flag: "stale", flagged_by: ctx.agent.id },
    }, { agentState: null });
    return { flagged: true };
  },
});

export const briefPublish = defineTool({
  name: "brief.publish",
  tier: "internal_write",
  integration: "internal",
  description:
    "Publish the daily brief (markdown). Call once, at the end, with the complete brief. The city sweeps a searchlight from the HQ spire when it lands.",
  schema: z.object({
    body_md: z.string().min(50).max(20_000),
    headline: z.string().min(3).max(160).describe("One line for the activity log"),
  }),
  describe: (a) => `Publish brief: ${a.headline}`,
  async execute(a, ctx) {
    const brief = await ctx.repo.insertBrief(a.body_md, ctx.runId);
    await emit(ctx.repo, {
      division_id: "hq",
      agent_id: ctx.agent.id,
      run_id: ctx.runId ?? undefined,
      type: "brief.published",
      level: "success",
      summary: toSummary(a.headline),
      payload: { brief_id: brief.id },
    }, { agentState: null });
    return { brief_id: brief.id };
  },
});

export const HQ_TOOLS = [divisionsList, runsRecent, approvalsList, spendSummary, hqDispatchRun, hqFlagStale, briefPublish];
