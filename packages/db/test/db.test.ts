import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emit } from "../src";
import { createTestDatabase, insertFixtures, type TestDatabase } from "../src/testing";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.sql.query(`insert into owners (user_id, note) values ($1, 'nico')`, [OWNER]);
});

afterEach(async () => {
  await t.close();
});

async function newApproval(overrides: Partial<Parameters<TestDatabase["repo"]["createApproval"]>[0]> = {}) {
  return t.repo.createApproval({
    division_id: "parlaylab",
    agent_id: "parlaylab.billing-01",
    run_id: null,
    tier: "financial",
    title: "Refund $19.00 to cus_123",
    rationale: "Double charge on 2026-10-08",
    action: { tool: "stripe.issue_refund", args: { payment_intent: "pi_1", amount_cents: 1900 } },
    action_hash: "hash-1",
    amount_cents: 1900,
    currency: "usd",
    ...overrides,
  });
}

describe("emit", () => {
  it("inserts the event and checks the agent in", async () => {
    const before = await t.repo.getAgent("parlaylab.billing-01");
    expect(before?.last_checkin_at).toBeNull();

    const event = await emit(t.repo, {
      division_id: "parlaylab",
      agent_id: "parlaylab.billing-01",
      type: "run.started",
      summary: "Review failed payments",
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event.level).toBe("info");

    const after = await t.repo.getAgent("parlaylab.billing-01");
    expect(after?.state).toBe("working");
    expect(after?.last_checkin_at).not.toBeNull();

    await emit(t.repo, { division_id: "parlaylab", agent_id: "parlaylab.billing-01", type: "run.failed", level: "error", summary: "Stripe timed out" });
    expect((await t.repo.getAgent("parlaylab.billing-01"))?.state).toBe("error");
  });

  it("rejects events that break the contract", async () => {
    await expect(emit(t.repo, { division_id: "hq", type: "run.started", summary: "" })).rejects.toThrow();
    // Even raw SQL cannot bypass the contract.
    await expect(
      t.sql.query(`insert into events (division_id, type, summary) values ('hq', 'made.up', 'x')`),
    ).rejects.toThrow();
    await expect(
      t.sql.query(`insert into events (division_id, type, summary) values ('hq', 'run.started', repeat('x', 201))`),
    ).rejects.toThrow();
  });

  it("merges metric.updated payloads into division metrics", async () => {
    await emit(t.repo, {
      division_id: "parlaylab",
      agent_id: "parlaylab.billing-01",
      type: "metric.updated",
      summary: "MRR $4,210",
      payload: { metrics: { mrr: { value: 4210, unit: "usd" } } },
    });
    await emit(t.repo, {
      division_id: "parlaylab",
      type: "metric.updated",
      summary: "Signups 31",
      payload: { metrics: { signups_7d: { value: 31 } } },
    });
    const division = await t.repo.getDivision("parlaylab");
    expect(division?.metrics.mrr?.value).toBe(4210);
    expect(division?.metrics.signups_7d?.unit).toBe("count");
    await expect(
      emit(t.repo, { division_id: "parlaylab", type: "metric.updated", summary: "bad", payload: { metrics: { "Bad Key": { value: 1 } } } }),
    ).rejects.toThrow();
  });
});

describe("approvals", () => {
  it("dedupes an open action per agent", async () => {
    const first = await newApproval();
    const second = await newApproval({ title: "Refund again" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.approval.id).toBe(first.approval.id);

    // Once closed, the same action can be proposed again.
    await t.repo.transitionApproval(first.approval.id, ["pending"], "rejected");
    const third = await newApproval();
    expect(third.created).toBe(true);
  });

  it("lets exactly one executor claim an approval", async () => {
    const { approval } = await newApproval();
    await t.repo.transitionApproval(approval.id, ["pending"], "approved");
    const claims = await Promise.all([
      t.repo.transitionApproval(approval.id, ["approved"], "executing"),
      t.repo.transitionApproval(approval.id, ["approved"], "executing"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const done = await t.repo.transitionApproval(approval.id, ["executing"], "executed", { result: { refund: "re_1" } });
    expect(done?.status).toBe("executed");
    expect(done?.executed_at).not.toBeNull();
    expect(done?.result).toEqual({ refund: "re_1" });
  });

  it("expires stale pending approvals", async () => {
    const { approval } = await newApproval({ expires_at: new Date(Date.now() - 1000) });
    const expired = await t.repo.expireStaleApprovals();
    expect(expired.map((a) => a.id)).toEqual([approval.id]);
  });
});

describe("row-level security", () => {
  it("shows the city only to owners", async () => {
    await emit(t.repo, { division_id: "hq", type: "brief.published", summary: "Brief ready" });
    const ownerRows = await t.asUser(OWNER, (sql) => sql.query(`select * from events`));
    const strangerRows = await t.asUser(STRANGER, (sql) => sql.query(`select * from events`));
    expect(ownerRows).toHaveLength(1);
    expect(strangerRows).toHaveLength(0);

    // Each user can see only their own owners row, and nobody can add one from the browser.
    expect(await t.asUser(OWNER, (sql) => sql.query(`select user_id from owners`))).toEqual([{ user_id: OWNER }]);
    expect(await t.asUser(STRANGER, (sql) => sql.query(`select user_id from owners`))).toEqual([]);
    await expect(
      t.asUser(STRANGER, (sql) => sql.query(`insert into owners (user_id) values ($1)`, [STRANGER])),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the owner decide a pending approval and nothing else", async () => {
    const { approval } = await newApproval();

    // Cannot rewrite the stored action.
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`update approvals set action = '{}'::jsonb where id = $1`, [approval.id])),
    ).rejects.toThrow(/permission denied/);

    // Cannot insert events or approvals from the browser.
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`insert into events (division_id, type, summary) values ('hq', 'run.started', 'x')`)),
    ).rejects.toThrow(/permission denied/);

    // A stranger's update matches no rows.
    const strangerUpdate = await t.asUser(STRANGER, (sql) =>
      sql.query(`update approvals set status = 'approved' where id = $1 returning id`, [approval.id]),
    );
    expect(strangerUpdate).toHaveLength(0);

    // Cannot move it to a state other than approved/rejected.
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`update approvals set status = 'executed' where id = $1`, [approval.id])),
    ).rejects.toThrow(/row-level security/);

    const decided = await t.asUser(OWNER, (sql) =>
      sql.query<{ status: string }>(
        `update approvals set status = 'rejected', decided_note = 'not a double charge' where id = $1 returning status`,
        [approval.id],
      ),
    );
    expect(decided[0]?.status).toBe("rejected");
    // The database records who decided, from the session (the browser cannot set it).
    expect(await t.repo.getApproval(approval.id)).toMatchObject({ decided_by: OWNER, decided_at: expect.any(String) });
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`update approvals set decided_by = $2 where id = $1`, [approval.id, STRANGER])),
    ).rejects.toThrow(/permission denied/);

    // Decided approvals are final.
    const again = await t.asUser(OWNER, (sql) =>
      sql.query(`update approvals set status = 'approved' where id = $1 returning id`, [approval.id]),
    );
    expect(again).toHaveLength(0);
  });

  it("refuses to approve an expired approval", async () => {
    const { approval } = await newApproval({ expires_at: new Date(Date.now() - 60_000) });
    const rows = await t.asUser(OWNER, (sql) =>
      sql.query(`update approvals set status = 'approved' where id = $1 returning id`, [approval.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("shows alert history to the owner only, and lets nobody write it from the browser", async () => {
    await t.repo.recordNotification({ kind: "digest", subject: "Agent City: 1 approval waiting", item_count: 1, status: "sent", provider_message_id: "m1", error: null });
    expect(await t.asUser(OWNER, (sql) => sql.query(`select subject from notifications`))).toEqual([{ subject: "Agent City: 1 approval waiting" }]);
    expect(await t.asUser(STRANGER, (sql) => sql.query(`select subject from notifications`))).toEqual([]);
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`insert into notifications (kind, subject, status) values ('digest', 'x', 'sent')`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the owner pause the city", async () => {
    await t.asUser(OWNER, (sql) => sql.query(`update settings set agents_paused = true where id`));
    expect((await t.repo.getSettings()).agents_paused).toBe(true);
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`update settings set trigger_api_url = 'https://evil.example' where id`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("run lineage", () => {
  it("links HQ-dispatched runs to the run that dispatched them, in one correlation chain", async () => {
    const root = await t.repo.createRun({ agent_id: "hq.hq-01", trigger: "cron", goal: "brief", model: null });
    expect(root).toMatchObject({ parent_run_id: null, correlation_id: root.id });

    const child = await t.repo.createRun({ agent_id: "parlaylab.billing-01", trigger: "hq", goal: "check", model: null, parent_run_id: root.id });
    expect(child).toMatchObject({ parent_run_id: root.id, correlation_id: root.id });

    const grandchild = await t.repo.createRun({ agent_id: "hq.hq-01", trigger: "hq", goal: "follow up", model: null, parent_run_id: child.id });
    expect(grandchild).toMatchObject({ parent_run_id: child.id, correlation_id: root.id });

    // An unknown parent (e.g. a run from another environment) starts a fresh chain instead of failing.
    const orphan = await t.repo.createRun({ agent_id: "hq.hq-01", trigger: "hq", goal: "x", model: null, parent_run_id: "00000000-0000-4000-8000-000000000000" });
    expect(orphan).toMatchObject({ parent_run_id: null, correlation_id: orphan.id });
  });
});

describe("approval decision triggers", () => {
  it("stamps the decision, logs it, frees the agent and dispatches execution", async () => {
    await t.setSecret("trigger_secret_key", "tr_prod_test");
    await t.repo.setAgentState("parlaylab.billing-01", "waiting_approval");
    const { approval } = await newApproval();

    await t.asUser(OWNER, (sql) => sql.query(`update approvals set status = 'approved' where id = $1`, [approval.id]));

    const stored = await t.repo.getApproval(approval.id);
    expect(stored?.decided_at).not.toBeNull();

    const [decided] = await t.repo.listEvents({ types: ["approval.decided"] });
    expect(decided?.summary).toBe("Approved: Refund $19.00 to cus_123");
    expect(decided?.payload).toMatchObject({ approval_id: approval.id, status: "approved" });

    expect((await t.repo.getAgent("parlaylab.billing-01"))?.state).toBe("idle");

    const requests = await t.netRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.trigger.dev/api/v1/tasks/execute-approval/trigger");
    expect(requests[0]?.headers.Authorization).toBe("Bearer tr_prod_test");
    expect(requests[0]?.body).toEqual({
      payload: { approvalId: approval.id },
      options: { payloadType: "application/json", idempotencyKey: `approval:${approval.id}` },
    });
  });

  it("does not dispatch rejections or when no secret is configured", async () => {
    const a = await newApproval({ action_hash: "a" });
    const b = await newApproval({ action_hash: "b" });
    await t.asUser(OWNER, (sql) => sql.query(`update approvals set status = 'rejected' where id = $1`, [a.approval.id]));
    await t.asUser(OWNER, (sql) => sql.query(`update approvals set status = 'approved' where id = $1`, [b.approval.id]));
    expect(await t.netRequests()).toHaveLength(0);
    expect(await t.repo.listEvents({ types: ["approval.decided"] })).toHaveLength(2);
  });
});

describe("secrets and spend", () => {
  it("reads scoped agent secrets from Vault", async () => {
    await t.setSecret("agent:parlaylab.billing-01:stripe", "rk_test_123");
    expect(await t.repo.getAgentSecret("parlaylab.billing-01", "stripe")).toBe("rk_test_123");
    expect(await t.repo.getAgentSecret("parlaylab.billing-01", "email")).toBeNull();
  });

  it("sums spend by agent and division", async () => {
    const run = await t.repo.createRun({ agent_id: "parlaylab.billing-01", trigger: "manual", goal: "x", model: "claude-sonnet-5-5" });
    await t.repo.updateRun(run.id, { cost_usd: 0.1234, status: "succeeded", ended_at: new Date() });
    const since = new Date(Date.now() - 60_000);
    expect(await t.repo.agentSpendSince("parlaylab.billing-01", since)).toBeCloseTo(0.1234, 4);
    expect(await t.repo.spendByDivision(since)).toEqual([{ division_id: "parlaylab", runs: 1, cost_usd: 0.1234 }]);
  });
});
