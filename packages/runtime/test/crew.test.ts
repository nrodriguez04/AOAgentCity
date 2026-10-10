import type { CrewSpec } from "@agent-city/core";
import { createTestDatabase, insertFixtures, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ampCrewClient,
  crewCost,
  normalizeCrewStatus,
  parseCrewConnection,
  PriceBook,
  runCrew,
  type CrewClient,
  type CrewRuntimeDeps,
  type CrewStatus,
  type ModelClient,
} from "../src";

const CREW_ID = "parlaylab.review-crew";
let t: TestDatabase;

const RESULT = {
  summary: "MRR up 3% to $4,330; churn steady; two recommendations",
  drafts: [{ kind: "report", channel: null, title: "ParlayLab weekly review: week of Oct 5", body_md: "# Weekly review\n\nMRR **$4,330** (+3%)." }],
  tasks: [{ title: "Test annual plan discount on the Pro tier", notes: "Hypothesis: ...", priority: 2, due_in_days: 3 }],
  metrics: null,
  metrics_summary: null,
  usage: { prompt_tokens: 10_000, completion_tokens: 2_000, cached_prompt_tokens: 4_000, cache_creation_tokens: 0, successful_requests: 4, models: ["anthropic/claude-sonnet-5-5"] },
};

const running = (current: string | null, done: number): CrewStatus => ({ state: "running", currentTask: current, completedTasks: done, totalTasks: 2 });
const completed = (output: unknown): CrewStatus => ({
  state: "completed",
  output: typeof output === "string" ? output : JSON.stringify(output),
  tasks: [
    { taskId: "analyze_week", agent: "Business analyst", output: "analysis", executionTime: 41.2 },
    { taskId: "write_review", agent: "Strategist", output: "review", executionTime: 55.0 },
  ],
  executionTime: 96.2,
});

/** A scripted AMP: each status call returns the next scripted status (the last one repeats). */
function fakeCrew(statuses: CrewStatus[], onStatus?: (call: number) => Promise<void>) {
  const kickoffs: { inputs: Record<string, string>; meta?: Record<string, unknown> }[] = [];
  let calls = 0;
  const client: CrewClient = {
    async kickoff(connection, body) {
      expect(connection).toEqual({ url: "https://review-crew.crewai.com", token: "crew-token" });
      kickoffs.push(body);
      return "kick-1";
    },
    async status(_connection, kickoffId) {
      expect(kickoffId).toBe("kick-1");
      calls++;
      await onStatus?.(calls);
      return statuses[Math.min(calls - 1, statuses.length - 1)]!;
    },
  };
  return { client, kickoffs, calls: () => calls };
}

const SPEC: CrewSpec = {
  project: "crews/review",
  tasks: [
    { id: "analyze_week", member: "Analyst", label: "Measuring the week" },
    { id: "write_review", member: "Strategist", label: "Writing the review" },
  ],
  async buildInputs(io) {
    const division = await io.call<{ name: string }>("division.get", { division_id: "parlaylab" });
    return { inputs: { business: division.name, week_label: "Week of Monday, Oct 5, 2026" } };
  },
};

const noModel: ModelClient = {
  async create() {
    throw new Error("crews never call the Claude model directly");
  },
};

function deps(client: CrewClient, extra: Partial<CrewRuntimeDeps> = {}): CrewRuntimeDeps {
  return { repo: t.repo, model: noModel, crewClient: client, sleep: async () => {}, crewPollMs: 0, ...extra };
}

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.db.exec(`
    insert into agents (id, division_id, display_name, role, model_tier, runtime, instructions, default_goal, daily_budget_usd)
    values ('${CREW_ID}', 'parlaylab', 'REVIEW CREW', 'Weekly business review', 'standard', 'crewai', 'A crew.', 'Write the weekly review', 2);
  `);
  await t.repo.replacePermissions(CREW_ID, [
    { tool_name: "division.get", max_tier: "read" },
    { tool_name: "draft.save", max_tier: "internal_write" },
    { tool_name: "task.create", max_tier: "internal_write" },
    { tool_name: "metric.record", max_tier: "internal_write" },
  ]);
  await t.setSecret(`agent:${CREW_ID}:crewai`, JSON.stringify({ url: "https://review-crew.crewai.com", token: "crew-token" }));
  delete process.env.AGENTS_PAUSED;
});

afterEach(async () => {
  await t.close();
});

describe("runCrew", () => {
  it("builds inputs through the gateway, follows each task, and applies the result as the crew", async () => {
    const crew = fakeCrew([running("analyze_week", 0), running("analyze_week", 0), running("write_review", 1), completed(RESULT)]);
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);

    expect(outcome).toMatchObject({ status: "succeeded", summary: RESULT.summary });
    expect(crew.kickoffs).toHaveLength(1);
    expect(crew.kickoffs[0]!.inputs).toEqual({ goal: "Write the weekly review", business: "ParlayLab", week_label: "Week of Monday, Oct 5, 2026" });
    expect(crew.kickoffs[0]!.meta).toMatchObject({ agent_id: CREW_ID });

    // The city sees the crew start, each member's task (once each), the draft and task, and the result.
    const events = (await t.repo.listEvents({ divisionId: "parlaylab" })).reverse();
    expect(events.map((e) => [e.type, e.summary])).toEqual([
      ["run.started", "Write the weekly review"],
      ["run.progress", "Analyst: Measuring the week (1/2)"],
      ["run.progress", "Strategist: Writing the review (2/2)"],
      ["run.progress", "Draft ready: ParlayLab weekly review: week of Oct 5"],
      ["task.created", "New task: Test annual plan discount on the Pro tier"],
      ["run.succeeded", RESULT.summary],
    ]);

    const run = (await t.repo.listRuns({ agentId: CREW_ID }))[0]!;
    expect(events.every((e) => e.agent_id === CREW_ID && e.run_id === run.id)).toBe(true);
    expect(run).toMatchObject({ status: "succeeded", model: "claude-sonnet-5-5", input_tokens: 6_000, output_tokens: 2_000, cache_read_tokens: 4_000 });
    // Sonnet 5.5: 6k uncached input at $2/M + 2k output at $10/M + 4k cache reads at $0.20/M.
    expect(run.cost_usd).toBeCloseTo(0.0328, 6);
    expect((await t.repo.getRun(run.id))?.transcript).toMatchObject({ runtime: "crewai", project: "crews/review", kickoff_id: "kick-1", cost_estimated: false });

    const [draft] = await t.repo.listDrafts({ runId: run.id });
    expect(draft).toMatchObject({ division_id: "parlaylab", agent_id: CREW_ID, kind: "report", title: RESULT.drafts[0]!.title, status: "draft" });
    const [task] = await t.repo.listTasks({ divisionId: "parlaylab" });
    expect(task).toMatchObject({ title: RESULT.tasks[0]!.title, priority: 2, source: CREW_ID, owner: "nico" });
    expect(new Date(task!.due_at!).getTime() - Date.now()).toBeGreaterThan(2.9 * 86_400_000);

    const calls = await t.sql.query<{ tool_name: string; status: string; run_id: string }>(`select tool_name, status, run_id from tool_calls order by id`);
    expect(calls.map((c) => [c.tool_name, c.status, c.run_id])).toEqual([
      ["division.get", "ok", run.id],
      ["draft.save", "ok", run.id],
      ["task.create", "ok", run.id],
    ]);
    expect((await t.repo.getAgent(CREW_ID))?.state).toBe("idle");
  });

  it("skips without a run when the crew is not connected to CrewAI yet", async () => {
    await t.sql.query(`delete from vault.secrets_stub`);
    const crew = fakeCrew([completed(RESULT)]);
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome).toMatchObject({ status: "skipped", reason: "not_configured" });
    expect(crew.kickoffs).toHaveLength(0);
    expect(await t.repo.listRuns({ agentId: CREW_ID })).toHaveLength(0);
    const [event] = await t.repo.listEvents({ divisionId: "parlaylab" });
    expect(event).toMatchObject({ type: "run.progress", level: "warning" });
    expect(event!.summary).toContain(`agent:${CREW_ID}:crewai`);
    expect((await t.repo.getAgent(CREW_ID))?.state).toBe("idle");
  });

  it("finishes without starting the crew when there is nothing to work on", async () => {
    const crew = fakeCrew([completed(RESULT)]);
    const spec: CrewSpec = { ...SPEC, buildInputs: async () => ({ skip: "ParlayLab has no data yet, so there is nothing to review." }) };
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, spec);
    expect(outcome).toMatchObject({ status: "succeeded", costUsd: 0, summary: "ParlayLab has no data yet, so there is nothing to review." });
    expect(crew.kickoffs).toHaveLength(0);
    expect((await t.repo.listRuns({ agentId: CREW_ID }))[0]).toMatchObject({ status: "succeeded", cost_usd: 0 });
  });

  it("records a failed run (red crown) when the crew errors on CrewAI", async () => {
    const crew = fakeCrew([running("analyze_week", 0), { state: "error", error: "Task execution failed: overloaded", executionTime: 12 }]);
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome).toMatchObject({ status: "failed" });
    expect((await t.repo.listRuns({ agentId: CREW_ID }))[0]).toMatchObject({ status: "failed" });
    const [last] = await t.repo.listEvents({ divisionId: "parlaylab" });
    expect(last).toMatchObject({ type: "run.failed", level: "error" });
    expect(last!.summary).toContain("overloaded");
    expect((await t.repo.getAgent(CREW_ID))?.state).toBe("error");
  });

  it("applies nothing when the crew's result does not match the contract", async () => {
    const crew = fakeCrew([completed({ summary: "ok", drafts: [{ kind: "tweetstorm", title: "x", body_md: "y" }] })]);
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ summary: expect.stringContaining("not valid") });
    expect(await t.repo.listDrafts({ agentId: CREW_ID })).toHaveLength(0);
  });

  it("only saves what the crew is granted, and says what it could not save", async () => {
    await t.repo.replacePermissions(CREW_ID, [
      { tool_name: "division.get", max_tier: "read" },
      { tool_name: "task.create", max_tier: "internal_write" },
    ]);
    const crew = fakeCrew([completed(RESULT)]);
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome.status).toBe("succeeded");
    expect(await t.repo.listDrafts({ agentId: CREW_ID })).toHaveLength(0);
    expect(await t.repo.listTasks({ divisionId: "parlaylab" })).toHaveLength(1);
    const summaries = (await t.repo.listEvents({ divisionId: "parlaylab" })).map((e) => e.summary);
    expect(summaries).toContain("Denied: draft.save");
    expect(summaries.some((s) => s.startsWith("1 of the crew's outputs could not be saved"))).toBe(true);
  });

  it("stops following the crew and ignores its result when the city is paused", async () => {
    const crew = fakeCrew([running("analyze_week", 0), completed(RESULT)], async (call) => {
      if (call === 1) await t.repo.setPaused(true);
    });
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome.status).toBe("cancelled");
    expect(await t.repo.listDrafts({ agentId: CREW_ID })).toHaveLength(0);
    expect((await t.repo.getAgent(CREW_ID))?.state).toBe("idle");
  });

  it("gives up on a crew that runs past its time limit", async () => {
    const crew = fakeCrew([running("analyze_week", 0)]);
    const outcome = await runCrew(deps(crew.client, { crewTimeoutMs: 0 }), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome).toMatchObject({ status: "failed", summary: expect.stringContaining("did not finish") });
  });

  it("does not start when the crew's budget is spent", async () => {
    await t.sql.query(`update agents set daily_budget_usd = 0.05 where id = $1`, [CREW_ID]);
    const crew = fakeCrew([completed(RESULT)]);
    const outcome = await runCrew(deps(crew.client), { agentId: CREW_ID, trigger: "cron" }, SPEC);
    expect(outcome).toMatchObject({ status: "skipped", reason: "budget" });
    expect(crew.kickoffs).toHaveLength(0);
  });
});

describe("CrewAI AMP client", () => {
  it("kicks off with the bearer token and reads status, per the AMP API", async () => {
    const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const body = String(input).endsWith("/kickoff")
        ? { kickoff_id: "abcd-1234" }
        : { status: "running", current_task: "write_review", progress: { completed_tasks: 1, total_tasks: 2 } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const client = ampCrewClient(fakeFetch);
    const connection = { url: "https://review-crew.crewai.com", token: "tok" };

    expect(await client.kickoff(connection, { inputs: { a: "1" } })).toBe("abcd-1234");
    expect(await client.status(connection, "abcd-1234")).toEqual({ state: "running", currentTask: "write_review", completedTasks: 1, totalTasks: 2 });
    expect(requests.map((r) => [r.method, r.url, r.headers.Authorization])).toEqual([
      ["POST", "https://review-crew.crewai.com/kickoff", "Bearer tok"],
      ["GET", "https://review-crew.crewai.com/status/abcd-1234", "Bearer tok"],
    ]);
    expect(requests[0]!.body).toEqual({ inputs: { a: "1" } });

    const failing = ampCrewClient((async () => new Response('{"error":"Unauthorized"}', { status: 401 })) as typeof fetch);
    await expect(failing.kickoff(connection, { inputs: {} })).rejects.toThrow(/401/);
  });

  it("normalizes completed and error statuses", () => {
    expect(
      normalizeCrewStatus({
        status: "completed",
        result: { output: '{"summary":"x"}', tasks: [{ task_id: "a", output: "o", agent: "Writer", execution_time: 2.5 }] },
        execution_time: 9,
      }),
    ).toEqual({ state: "completed", output: '{"summary":"x"}', tasks: [{ taskId: "a", agent: "Writer", output: "o", executionTime: 2.5 }], executionTime: 9 });
    expect(normalizeCrewStatus({ status: "error", error: "Invalid API key", execution_time: 3 })).toEqual({ state: "error", error: "Invalid API key", executionTime: 3 });
    expect(normalizeCrewStatus({ status: "queued" })).toMatchObject({ state: "running", currentTask: null });
  });

  it("reads the crew's Vault secret as {url, token}", () => {
    expect(parseCrewConnection('{"url":"https://x.crewai.com","token":"t"}')).toEqual({ url: "https://x.crewai.com", token: "t" });
    expect(parseCrewConnection('{"url":"http://localhost:8000","token":"t"}')).toMatchObject({ url: "http://localhost:8000" });
    expect(parseCrewConnection('{"url":"http://x.crewai.com","token":"t"}')).toBeNull();
    expect(parseCrewConnection('{"url":"https://x.crewai.com"}')).toBeNull();
    expect(parseCrewConnection("just-a-token")).toBeNull();
    expect(parseCrewConnection(null)).toBeNull();
  });

  it("prices a crew at the most expensive model it used, and estimates when it reports nothing", async () => {
    const prices = new PriceBook(t.repo);
    const agent = (await t.repo.getAgent(CREW_ID))!;
    const mixed = await crewCost(
      prices,
      { prompt_tokens: 1_000_000, completion_tokens: 0, cached_prompt_tokens: 0, cache_creation_tokens: 0, successful_requests: 10, models: ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5"] },
      agent,
    );
    expect(mixed.totals.cost_usd).toBeCloseTo(4, 6); // 1M input at Opus 5.5's $4/M
    expect(mixed.estimated).toBe(false);
    const none = await crewCost(prices, null, agent);
    expect(none).toMatchObject({ estimated: true, model: "crewai" });
    expect(none.totals.cost_usd).toBeGreaterThan(0);
  });
});
