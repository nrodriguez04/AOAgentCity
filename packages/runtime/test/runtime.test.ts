import { createTestDatabase, insertFixtures, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRequest,
  executeApproval,
  runAgent,
  sweep,
  type CreateParams,
  type ModelClient,
  type ModelMessage,
} from "../src";

let t: TestDatabase;

type Block = Record<string, unknown>;
type Script = (params: CreateParams) => { content: Block[]; stop_reason: string; usage?: Partial<ModelMessage["usage"]>; model?: string; stop_details?: unknown };

function message(spec: ReturnType<Script>, model: string): ModelMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: spec.model ?? model,
    content: spec.content,
    stop_reason: spec.stop_reason,
    stop_sequence: null,
    stop_details: spec.stop_details ?? null,
    usage: {
      input_tokens: 1_000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      iterations: null,
      ...spec.usage,
    },
  } as unknown as ModelMessage;
}

/** A scripted model: each call takes the next step. Records requests. */
function fakeModel(steps: Script[]) {
  const requests: CreateParams[] = [];
  const client: ModelClient = {
    async create(params) {
      requests.push(structuredClone(params));
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      return message(step(params), params.model);
    },
  };
  return { client, requests };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
const text = (value: string): Block => ({ type: "text", text: value });

const EMAIL = {
  to: "fan@example.com",
  subject: "Your ParlayLab payment didn't go through",
  body_text: "Hi! Your card was declined on renewal. Update it from your account page and you're all set.",
  _rationale: "Second failed attempt on invoice in_1; Stripe retries in 3 days.",
};

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.repo.replacePermissions("parlaylab.billing-01", [
    { tool_name: "task.create", max_tier: "internal_write" },
    { tool_name: "email.send", max_tier: "external_effect" },
  ]);
  await t.sql.query(`update agents set default_goal = 'Review failed payments and draft dunning emails' where id = 'parlaylab.billing-01'`);
  delete process.env.AGENTS_PAUSED;
});

afterEach(async () => {
  await t.close();
});

describe("runAgent", () => {
  it("runs the tool loop, queues approvals without executing them, and records everything", async () => {
    const model = fakeModel([
      () => ({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          toolUse("tu_1", "email__send", EMAIL),
          toolUse("tu_2", "task__create", { division_id: "parlaylab", title: "Follow up on 3 past-due accounts", priority: 2 }),
        ],
      }),
      () => ({ stop_reason: "end_turn", content: [text("Queued 1 dunning email for approval and opened 1 follow-up task.\n- 3 past-due accounts")] }),
    ]);

    const outcome = await runAgent({ repo: t.repo, model: model.client }, { agentId: "parlaylab.billing-01", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "waiting_approval", steps: 2, summary: "Queued 1 dunning email for approval and opened 1 follow-up task." });
    if (outcome.status === "skipped") throw new Error("unexpected skip");

    // Request shape: cached system prompt with runtime rules, tools by API name, effort, fallbacks for Sonnet.
    const first = model.requests[0]!;
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.tools?.map((tool) => (tool as { name: string }).name)).toEqual(["email__send", "task__create"]);
    expect(JSON.stringify(first.system)).toContain("Agent City runtime rules");
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first.fallbacks).toBe("default");
    expect(String((first.messages[0] as { content: string }).content)).toContain("GOAL: Review failed payments and draft dunning emails");

    // The second request carries the assistant turn verbatim (thinking block included) and both tool results in one user turn.
    const second = model.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(JSON.stringify(second.messages[1])).toContain("sig-1");
    const results = second.messages[2]!.content as { type: string; tool_use_id: string; content: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["tu_1", "tu_2"]);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ status: "pending_approval" });

    // Nothing was sent; an approval holds the exact message.
    const [approval] = await t.repo.listApprovals();
    expect(approval).toMatchObject({ status: "pending", tier: "external_effect", run_id: outcome.runId });
    expect(approval?.action.args).toEqual({ to: EMAIL.to, subject: EMAIL.subject, body_text: EMAIL.body_text });

    const run = await t.repo.getRun(outcome.runId);
    expect(run).toMatchObject({ status: "waiting_approval", input_tokens: 2_000, output_tokens: 400 });
    // Sonnet: 2,000 in at $2/M + 400 out at $10/M
    expect(run?.cost_usd).toBeCloseTo(0.004 + 0.004, 6);
    expect((run?.transcript as { messages: unknown[] }).messages).toHaveLength(4);

    const types = (await t.repo.listEvents()).map((e) => e.type).reverse();
    expect(types).toEqual(["run.started", "approval.requested", "task.created", "run.succeeded"]);
    expect((await t.repo.getAgent("parlaylab.billing-01"))?.state).toBe("waiting_approval");
  });

  it("feeds unknown tools and invalid args back to the model as errors", async () => {
    const model = fakeModel([
      () => ({ stop_reason: "tool_use", content: [toolUse("tu_1", "stripe__wire_money", {}), toolUse("tu_2", "task__create", { title: "x" })] }),
      () => ({ stop_reason: "end_turn", content: [text("Nothing to do.")] }),
    ]);
    const outcome = await runAgent({ repo: t.repo, model: model.client }, { agentId: "parlaylab.billing-01", trigger: "manual" });
    expect(outcome.status).toBe("succeeded");
    const results = model.requests[1]!.messages[2]!.content as { is_error: boolean; content: string }[];
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results[0]!.content).toContain("unknown_tool");
    expect(results[1]!.content).toContain("invalid_args");
  });

  it("fails runs that exceed the step limit and turns the agent red", async () => {
    const model = fakeModel([() => ({ stop_reason: "tool_use", content: [toolUse("tu", "task__create", { division_id: "parlaylab", title: "loop forever please" })] })]);
    const outcome = await runAgent({ repo: t.repo, model: model.client, maxSteps: 3 }, { agentId: "parlaylab.billing-01", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "failed", summary: "max steps exceeded (3)" });
    const [failed] = await t.repo.listEvents({ types: ["run.failed"] });
    expect(failed).toMatchObject({ level: "error", summary: "Failed: max steps exceeded (3)" });
    expect((await t.repo.getAgent("parlaylab.billing-01"))?.state).toBe("error");
  });

  it("records refusals and API errors as failed runs", async () => {
    const refusing = fakeModel([() => ({ stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: "cyber" } })]);
    expect(await runAgent({ repo: t.repo, model: refusing.client }, { agentId: "parlaylab.billing-01", trigger: "manual" })).toMatchObject({
      status: "failed",
      summary: "the model declined (cyber)",
    });
    const broken: ModelClient = { create: async () => Promise.reject(new Error("socket hang up")) };
    expect(await runAgent({ repo: t.repo, model: broken }, { agentId: "parlaylab.billing-01", trigger: "manual" })).toMatchObject({
      status: "failed",
      summary: "socket hang up",
    });
  });

  it("prices refusal-fallback attempts at each model's own rates", async () => {
    const model = fakeModel([
      () => ({
        stop_reason: "end_turn",
        content: [{ type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-opus-4-8" } }, text("Done.")],
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          iterations: [
            { type: "message", model: "claude-sonnet-5-5", input_tokens: 1_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
          ] as never,
        },
      }),
    ]);
    const outcome = await runAgent({ repo: t.repo, model: model.client }, { agentId: "parlaylab.billing-01", trigger: "manual" });
    if (outcome.status === "skipped") throw new Error("unexpected skip");
    // Sonnet attempt: 1,000 x $2/M; Opus 4.8 fallback: 1,000 x $5/M + 100 x $25/M
    expect(outcome.costUsd).toBeCloseTo(0.002 + 0.005 + 0.0025, 6);
  });

  it("respects the kill switch before and during a run", async () => {
    await t.repo.setPaused(true);
    const idle = fakeModel([() => ({ stop_reason: "end_turn", content: [text("x")] })]);
    expect(await runAgent({ repo: t.repo, model: idle.client }, { agentId: "parlaylab.billing-01", trigger: "cron" })).toMatchObject({ status: "skipped", reason: "paused" });
    expect(idle.requests).toHaveLength(0);
    await t.repo.setPaused(false);

    process.env.AGENTS_PAUSED = "true";
    expect(await runAgent({ repo: t.repo, model: idle.client }, { agentId: "parlaylab.billing-01", trigger: "cron" })).toMatchObject({ status: "skipped", reason: "paused" });
    delete process.env.AGENTS_PAUSED;

    const pausing = fakeModel([
      () => {
        void t.repo.setPaused(true);
        return { stop_reason: "tool_use", content: [toolUse("tu", "task__create", { division_id: "parlaylab", title: "Pause test task" })] };
      },
    ]);
    const outcome = await runAgent({ repo: t.repo, model: pausing.client }, { agentId: "parlaylab.billing-01", trigger: "cron" });
    expect(outcome).toMatchObject({ status: "cancelled", summary: "the city was paused" });
    expect((await t.repo.getAgent("parlaylab.billing-01"))?.state).toBe("idle");
  });

  it("enforces the daily budget before and during a run", async () => {
    const earlier = await t.repo.createRun({ agent_id: "parlaylab.billing-01", trigger: "cron", goal: "x", model: "claude-sonnet-5-5" });
    await t.repo.updateRun(earlier.id, { status: "succeeded", cost_usd: 1.45 });
    const model = fakeModel([() => ({ stop_reason: "end_turn", content: [text("x")] })]);
    const outcome = await runAgent({ repo: t.repo, model: model.client }, { agentId: "parlaylab.billing-01", trigger: "cron" });
    expect(outcome).toMatchObject({ status: "skipped", reason: "budget" });
    const [warning] = await t.repo.listEvents();
    expect(warning).toMatchObject({ type: "run.progress", level: "warning" });
    expect(warning?.summary).toMatch(/^Budget cap: BILLING-01 has spent \$1\.45/);

    await t.repo.updateRun(earlier.id, { cost_usd: 0.01 });
    const expensive = fakeModel([
      () => ({ stop_reason: "tool_use", usage: { input_tokens: 400_000, output_tokens: 100_000 }, content: [toolUse("tu", "task__create", { division_id: "parlaylab", title: "Expensive step" })] }),
    ]);
    const midRun = await runAgent({ repo: t.repo, model: expensive.client }, { agentId: "parlaylab.billing-01", trigger: "cron" });
    expect(midRun).toMatchObject({ status: "cancelled" });
    expect(midRun.status !== "skipped" && midRun.summary).toMatch(/daily budget of \$1\.50 reached mid-run/);
  });

  it("skips agents that already have a run in progress", async () => {
    await t.repo.createRun({ agent_id: "parlaylab.billing-01", trigger: "cron", goal: "x", model: "m" });
    const model = fakeModel([() => ({ stop_reason: "end_turn", content: [text("x")] })]);
    expect(await runAgent({ repo: t.repo, model: model.client }, { agentId: "parlaylab.billing-01", trigger: "hq", goal: "Another" })).toMatchObject({ status: "skipped", reason: "busy" });
  });
});

describe("approval execution", () => {
  async function approvedEmail() {
    const model = fakeModel([
      () => ({ stop_reason: "tool_use", content: [toolUse("tu_1", "email__send", EMAIL)] }),
      () => ({ stop_reason: "end_turn", content: [text("Queued one email.")] }),
    ]);
    const outcome = await runAgent({ repo: t.repo, model: model.client }, { agentId: "parlaylab.billing-01", trigger: "manual" });
    const [approval] = await t.repo.listApprovals();
    await t.sql.query(`update approvals set status = 'approved' where id = $1`, [approval!.id]);
    return { approval: approval!, runId: outcome.status === "skipped" ? null : outcome.runId };
  }

  function fakeResend() {
    const sent: RequestInit[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ id: "em_123" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent };
  }

  beforeEach(() => {
    process.env.AGENT_SECRET__PARLAYLAB_BILLING_01__EMAIL = "re_test_123";
    process.env.EMAIL_FROM = "ParlayLab <support@parlaylab.test>";
  });

  it("executes the stored action exactly once, even when delivered twice", async () => {
    const { approval, runId } = await approvedEmail();
    const resend = fakeResend();
    const deps = { repo: t.repo, services: { fetch: resend.fetch } };
    const outcomes = await Promise.all([executeApproval(deps, approval.id), executeApproval(deps, approval.id)]);
    expect(outcomes.sort()).toEqual(["already_claimed", "executed"]);
    expect(resend.sent).toHaveLength(1);
    expect(JSON.parse(String(resend.sent[0]!.body))).toMatchObject({ to: [EMAIL.to], subject: EMAIL.subject, text: EMAIL.body_text });
    expect((resend.sent[0]!.headers as Record<string, string>)["Idempotency-Key"]).toBe(`email:${approval.id}`);

    const stored = await t.repo.getApproval(approval.id);
    expect(stored).toMatchObject({ status: "executed", result: { sent: true, provider: "resend", message_id: "em_123" } });
    expect(await executeApproval(deps, approval.id)).toBe("not_approved");

    const [done] = await t.repo.listEvents({ types: ["action.executed"] });
    expect(done).toMatchObject({ level: "success", summary: `Done: ${approval.title}` });
    expect((await t.repo.getRun(runId!))?.status).toBe("succeeded");
  });

  it("refuses expired approvals and revoked permissions", async () => {
    const { approval } = await approvedEmail();
    await t.sql.query(`update approvals set expires_at = now() - interval '1 minute' where id = $1`, [approval.id]);
    expect(await executeApproval({ repo: t.repo, services: { fetch: fakeResend().fetch } }, approval.id)).toBe("expired");

    await t.sql.query(`update approvals set status = 'approved', expires_at = now() + interval '1 hour' where id = $1`, [approval.id]);
    await t.repo.replacePermissions("parlaylab.billing-01", []);
    const resend = fakeResend();
    expect(await executeApproval({ repo: t.repo, services: { fetch: resend.fetch } }, approval.id)).toBe("failed");
    expect(resend.sent).toHaveLength(0);
    expect((await t.repo.getApproval(approval.id))?.result).toEqual({ error: "permission revoked" });
  });

  it("waits while the city is paused", async () => {
    const { approval } = await approvedEmail();
    await t.repo.setPaused(true);
    expect(await executeApproval({ repo: t.repo, services: { fetch: fakeResend().fetch } }, approval.id)).toBe("paused");
    expect((await t.repo.getApproval(approval.id))?.status).toBe("approved");
  });

  it("records integration failures without retrying them", async () => {
    const { approval } = await approvedEmail();
    const failing = (async () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })) as unknown as typeof fetch;
    expect(await executeApproval({ repo: t.repo, services: { fetch: failing } }, approval.id)).toBe("failed");
    expect((await t.repo.getApproval(approval.id))?.result).toEqual({ error: "send_failed", message: "Resend 403: domain not verified" });
    const [failed] = await t.repo.listEvents({ types: ["action.executed"] });
    expect(failed?.level).toBe("error");
  });
});

describe("sweep", () => {
  it("expires stale approvals, executes undelivered ones and fails lost runs", async () => {
    const now = new Date();
    const expiring = await t.repo.createApproval({
      division_id: "parlaylab", agent_id: "parlaylab.billing-01", run_id: null, tier: "external_effect",
      title: "Old email", rationale: "r", action: { tool: "email.send", args: { to: "a@b.co", subject: "s", body_text: "b" } },
      action_hash: "old", expires_at: new Date(now.getTime() - 1_000),
    });
    const approved = await t.repo.createApproval({
      division_id: "parlaylab", agent_id: "parlaylab.billing-01", run_id: null, tier: "external_effect",
      title: "Approved email", rationale: "r", action: { tool: "email.send", args: { to: "c@d.co", subject: "s", body_text: "b" } },
      action_hash: "new",
    });
    // decided_at is stamped by the database trigger; the sweep's clock runs a minute ahead instead.
    await t.sql.query(`update approvals set status = 'approved' where id = $1`, [approved.approval.id]);
    const lost = await t.repo.createRun({ agent_id: "parlaylab.billing-01", trigger: "cron", goal: "x", model: "m" });
    await t.sql.query(`update runs set started_at = now() - interval '1 hour' where id = $1`, [lost.id]);

    process.env.AGENT_SECRET__PARLAYLAB_BILLING_01__EMAIL = "re_test_123";
    process.env.EMAIL_FROM = "ParlayLab <support@parlaylab.test>";
    const ok = (async () => new Response(JSON.stringify({ id: "em_9" }), { status: 200 })) as unknown as typeof fetch;
    const report = await sweep({ repo: t.repo, services: { fetch: ok }, now: () => new Date(Date.now() + 60_000) });

    expect(report).toEqual({ expired: 1, executed: { [approved.approval.id]: "executed" }, stuckReported: 0, staleRunsFailed: 1 });
    expect((await t.repo.getApproval(expiring.approval.id))?.status).toBe("expired");
    expect((await t.repo.getRun(lost.id))?.status).toBe("failed");
  });
});

describe("request builder", () => {
  it("opts Opus and Sonnet into refusal fallbacks but not Haiku", () => {
    const shape = { system: "s", tools: [], messages: [{ role: "user" as const, content: "hi" }] };
    expect(buildRequest({ ...shape, tier: "reasoning" })).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "high" } });
    const fast = buildRequest({ ...shape, tier: "fast" });
    expect(fast).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect(fast.fallbacks).toBeUndefined();
    expect(fast.cache_control).toEqual({ type: "ephemeral" });
    expect(fast.tools).toBeUndefined();
  });
});

describe("stuck executions", () => {
  it("reports an action whose executor died, once, and never retries it", async () => {
    const { approval } = await t.repo.createApproval({
      division_id: "parlaylab", agent_id: "parlaylab.billing-01", run_id: null, tier: "financial",
      title: "Refund $19.00 to sam@example.com", rationale: "r",
      action: { tool: "stripe.issue_refund", args: { payment_intent: "pi_1", amount_cents: 1900, currency: "usd" } },
      action_hash: "stuck",
    });
    await t.sql.query(`update approvals set status = 'approved' where id = $1`, [approval.id]);
    await t.repo.transitionApproval(approval.id, ["approved"], "executing");
    const later = () => new Date(Date.now() + 30 * 60_000);

    expect((await sweep({ repo: t.repo, now: later })).stuckReported).toBe(1);
    expect((await sweep({ repo: t.repo, now: later })).stuckReported).toBe(0);
    expect((await t.repo.getApproval(approval.id))?.status).toBe("executing");
    const [alert] = await t.repo.listEvents({ types: ["action.executed"] });
    expect(alert).toMatchObject({ level: "error", summary: "Outcome unknown, check before retrying: Refund $19.00 to sam@example.com" });

    // While it is unresolved, the same action cannot be queued again.
    const again = await t.repo.createApproval({
      division_id: "parlaylab", agent_id: "parlaylab.billing-01", run_id: null, tier: "financial",
      title: "Refund again", rationale: "r", action: { tool: "stripe.issue_refund", args: {} }, action_hash: "stuck",
    });
    expect(again).toMatchObject({ created: false });
  });
});
