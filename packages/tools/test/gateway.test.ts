import { RISK_TIERS, requiresApproval } from "@agent-city/core";
import { createTestDatabase, insertFixtures, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  apiToolDefinition,
  apiToolsFor,
  buildRfc2822,
  canonicalJson,
  getTool,
  hashAction,
  invoke,
  monthlyAmount,
  plainText,
  secretEnvName,
  toolFromApiName,
  type GatewayContext,
} from "../src";

let t: TestDatabase;
let billing: GatewayContext;
let hq: GatewayContext;

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.repo.replacePermissions("parlaylab.billing-01", [
    { tool_name: "task.list", max_tier: "read" },
    { tool_name: "task.create", max_tier: "internal_write" },
    { tool_name: "metric.record", max_tier: "internal_write" },
    { tool_name: "stripe.issue_refund", max_tier: "financial" },
    { tool_name: "email.send", max_tier: "external_effect" },
    // Granted below the tool's tier on purpose: must still be denied.
    { tool_name: "stripe.list_subscriptions", max_tier: "read" },
    { tool_name: "email.draft", max_tier: "read" },
  ]);
  billing = { repo: t.repo, agent: (await t.repo.getAgent("parlaylab.billing-01"))!, runId: null };
  hq = { repo: t.repo, agent: (await t.repo.getAgent("hq.hq-01"))!, runId: null };
});

afterEach(async () => {
  await t.close();
});

const refundArgs = {
  payment_intent: "pi_3Q",
  amount_cents: 1900,
  currency: "usd",
  reason: "duplicate",
  customer_email: "fan@example.com",
  _rationale: "Customer was charged twice on Oct 8 for the same Pro renewal.",
};

describe("registry", () => {
  it("registers every tool with a known tier and an API-safe name", () => {
    for (const tool of ALL_TOOLS) {
      expect(RISK_TIERS).toContain(tool.tier);
      expect(toolFromApiName(apiToolDefinition(tool).name)).toBe(tool);
    }
  });

  it("asks for a rationale on every approval-tier tool", () => {
    for (const tool of ALL_TOOLS.filter((x) => requiresApproval(x.tier))) {
      const def = apiToolDefinition(tool);
      expect(def.input_schema.required).toContain("_rationale");
      expect(def.description).toMatch(/does NOT perform the action/);
    }
  });

  it("emits tool lists in a stable order for prompt caching", () => {
    const a = apiToolsFor(["task.create", "stripe.issue_refund", "task.list"]).map((d) => d.name);
    const b = apiToolsFor(["task.list", "task.create", "stripe.issue_refund", "task.list"]).map((d) => d.name);
    expect(a).toEqual(b);
    expect(a).toEqual(["stripe__issue_refund", "task__create", "task__list"]);
  });

  it("has no money-movement tools outside the approval gate", () => {
    const moneyMovers = ALL_TOOLS.filter((x) => /refund|charge|transfer|payout|price/.test(x.name) && !x.name.includes("list"));
    for (const tool of moneyMovers) expect(tool.tier).toBe("financial");
  });
});

describe("gateway", () => {
  it("rejects unknown tools and logs the attempt", async () => {
    expect(await invoke(billing, "stripe.delete_everything", {})).toEqual({ error: "unknown_tool", tool: "stripe.delete_everything" });
    const [row] = await t.sql.query<{ status: string }>(`select status from tool_calls`);
    expect(row?.status).toBe("denied");
  });

  it("denies tools the agent was not granted, or granted below the tool's tier", async () => {
    expect(await invoke(billing, "brief.publish", { body_md: "x".repeat(60), headline: "hi" })).toMatchObject({ error: "permission_denied" });
    expect(await invoke(billing, "email.draft", { to: "a@b.co", subject: "s", body_text: "b" })).toMatchObject({ error: "permission_denied" });
    const warnings = await t.repo.listEvents({ types: ["run.progress"] });
    expect(warnings.map((e) => e.summary)).toEqual(["Denied: email.draft", "Denied: brief.publish"]);
    expect(warnings.every((e) => e.level === "warning")).toBe(true);
  });

  it("validates arguments", async () => {
    const result = await invoke(billing, "task.create", { division_id: "parlaylab", title: "x" });
    expect(result).toMatchObject({ error: "invalid_args" });
  });

  it("executes internal writes immediately and emits their events", async () => {
    const result = await invoke(billing, "task.create", { division_id: "parlaylab", title: "Retry dunning for 3 accounts", priority: 2 });
    expect(result).toMatchObject({ status: "ok" });
    const [task] = await t.repo.listTasks();
    expect(task).toMatchObject({ title: "Retry dunning for 3 accounts", priority: 2, source: "parlaylab.billing-01" });
    const [event] = await t.repo.listEvents({ types: ["task.created"] });
    expect(event?.summary).toBe("New task: Retry dunning for 3 accounts");
  });

  it("keeps division agents inside their division", async () => {
    const result = await invoke(billing, "task.create", { division_id: "hq", title: "Take over HQ" });
    expect(result).toMatchObject({ error: "out_of_scope" });
  });

  it("queues financial actions for approval instead of executing them", async () => {
    const result = await invoke(billing, "stripe.issue_refund", refundArgs);
    expect(result).toMatchObject({ status: "pending_approval", deduplicated: false });

    const [approval] = await t.repo.listApprovals();
    expect(approval).toMatchObject({
      tier: "financial",
      status: "pending",
      title: "Refund $19.00 to fan@example.com (pi_3Q, duplicate)",
      rationale: refundArgs._rationale,
      amount_cents: 1900,
      currency: "usd",
    });
    // Stored verbatim, minus the rationale.
    expect(approval?.action).toEqual({
      tool: "stripe.issue_refund",
      args: { payment_intent: "pi_3Q", amount_cents: 1900, currency: "usd", reason: "duplicate", customer_email: "fan@example.com" },
    });
    expect(approval?.action_hash).toBe(hashAction(approval!.action));

    const [requested] = await t.repo.listEvents({ types: ["approval.requested"] });
    expect(requested).toMatchObject({ level: "warning", summary: approval?.title });

    // The same action again is deduplicated, with no second event.
    const again = await invoke(billing, "stripe.issue_refund", { ...refundArgs, _rationale: "Re-checking the double charge from earlier." });
    expect(again).toMatchObject({ status: "pending_approval", deduplicated: true, approval_id: approval?.id });
    expect(await t.repo.listEvents({ types: ["approval.requested"] })).toHaveLength(1);
  });

  it("requires a rationale and enforces the refund hard limit", async () => {
    const { _rationale, ...noRationale } = refundArgs;
    expect(await invoke(billing, "stripe.issue_refund", noRationale)).toMatchObject({ error: "invalid_args" });
    expect(await invoke(billing, "stripe.issue_refund", { ...refundArgs, amount_cents: 10_000_000 })).toMatchObject({ error: "invalid_args" });
    expect(await invoke(billing, "stripe.issue_refund", { ...refundArgs, charge: "ch_1" })).toMatchObject({ error: "invalid_args" });
    expect(await t.repo.listApprovals()).toHaveLength(0);
  });

  it("queues external effects for approval", async () => {
    const result = await invoke(billing, "email.send", {
      to: "fan@example.com",
      subject: "Your payment didn't go through",
      body_text: "Hi! Your card was declined on renewal. You can update it here.",
      _rationale: "Second failed attempt; Stripe retries again in 3 days.",
    });
    expect(result).toMatchObject({ status: "pending_approval" });
    const [approval] = await t.repo.listApprovals();
    expect(approval).toMatchObject({ tier: "external_effect", title: "Email fan@example.com: Your payment didn't go through", amount_cents: null });
  });

  it("records metrics onto the division", async () => {
    await invoke(billing, "metric.record", { metrics: { failed_payments: { value: 3 } }, summary: "3 failed payments this week" });
    const division = await t.repo.getDivision("parlaylab");
    expect(division?.metrics.failed_payments?.value).toBe(3);
  });

  it("lets HQ act across divisions only with granted tools", async () => {
    await t.repo.replacePermissions("hq.hq-01", [{ tool_name: "task.create", max_tier: "internal_write" }]);
    expect(await invoke(hq, "task.create", { division_id: "parlaylab", title: "Review churn spike" })).toMatchObject({ status: "ok" });
    expect(await invoke(hq, "stripe.issue_refund", refundArgs)).toMatchObject({ error: "permission_denied" });
  });
});

describe("integration helpers", () => {
  it("canonicalizes JSON key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
    expect(hashAction({ tool: "x", args: { a: 1, b: 2 } })).toBe(hashAction({ tool: "x", args: { b: 2, a: 1 } }));
  });

  it("normalizes recurring prices to MRR", () => {
    const price = (interval: "day" | "week" | "month" | "year", unit: number, count = 1) =>
      ({ unit_amount: unit, recurring: { interval, interval_count: count } }) as never;
    expect(monthlyAmount(price("month", 1900), 1)).toBe(1900);
    expect(monthlyAmount(price("year", 12000), 2)).toBe(2000);
    expect(monthlyAmount(price("month", 3000, 3), 1)).toBe(1000);
    expect(monthlyAmount(price("week", 1200), 1)).toBeCloseTo(5200, 6);
  });

  it("builds RFC 2822 replies and reads Gmail bodies", () => {
    const raw = buildRfc2822({ to: "a@b.co", subject: "Re: Remboursé ✓", body_text: "Line 1\nLine 2", in_reply_to: "<m1@x>" });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("In-Reply-To: <m1@x>");
    expect(raw).toContain("\r\n\r\nLine 1\r\nLine 2");
    const encoded = Buffer.from("hello there", "utf8").toString("base64url");
    expect(plainText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: encoded } }] })).toBe("hello there");
  });

  it("names env fallbacks for scoped secrets", () => {
    expect(secretEnvName("parlaylab.billing-01", "stripe")).toBe("AGENT_SECRET__PARLAYLAB_BILLING_01__STRIPE");
  });

  it("sends approved email through Resend with the approval as idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    process.env.EMAIL_FROM_PARLAYLAB = "ParlayLab <support@parlaylab.test>";
    const result = await getTool("email.send")!.execute(
      { to: "fan@example.com", subject: "Hi", body_text: "Body" },
      {
        repo: t.repo,
        agent: billing.agent,
        runId: null,
        secret: "re_test_key",
        idempotencyKey: "a0d1f6c2-0000-4000-8000-000000000001",
        services: { fetch: fakeFetch },
        now: () => new Date(),
      },
    );
    expect(result).toMatchObject({ sent: true, provider: "resend", message_id: "em_1" });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(headers["Idempotency-Key"]).toBe("email:a0d1f6c2-0000-4000-8000-000000000001");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ from: "ParlayLab <support@parlaylab.test>", to: ["fan@example.com"] });
  });
});
