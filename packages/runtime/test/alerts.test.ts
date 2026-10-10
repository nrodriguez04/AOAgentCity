import { createTestDatabase, insertFixtures, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertConfigFromEnv, redactContacts, sendOwnerAlerts, type AlertConfig } from "../src";

let t: TestDatabase;
const NOW = new Date("2026-10-12T14:00:00Z");
const CONFIG: AlertConfig = { resendApiKey: "re_test", to: "owner@example.com", from: "Agent City <alerts@example.com>", cityUrl: "https://city.example.com" };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { from: string; to: string[]; subject: string; text: string };
}

/** A fake Resend: records each request and answers with the next scripted status (the last repeats). */
function fakeResend(statuses: number[] = [200]) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const status = statuses[Math.min(sent.length - 1, statuses.length - 1)]!;
    return new Response(JSON.stringify(status < 400 ? { id: `msg_${sent.length}` } : { message: "rate limited" }), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}

async function pendingRefund(title = "Refund $19.00 to jordan.lee@example.com") {
  const { approval } = await t.repo.createApproval({
    division_id: "parlaylab",
    agent_id: "parlaylab.billing-01",
    run_id: null,
    tier: "financial",
    title,
    rationale: "Charged twice within a minute for the same invoice. Customer phone on file (312) 555-0142.",
    action: { tool: "stripe.issue_refund", args: { charge: "ch_1", amount_cents: 1900 } },
    action_hash: `h-${title}`,
    amount_cents: 1900,
    currency: "usd",
  });
  return approval;
}

async function failedRun(endedAt: Date, error = "Stripe 401: invalid API key") {
  const run = await t.repo.createRun({ agent_id: "parlaylab.billing-01", trigger: "cron", goal: "x", model: null });
  await t.repo.updateRun(run.id, { status: "failed", ended_at: endedAt, error });
  return run;
}

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
});
afterEach(async () => {
  await t.close();
});

describe("owner alerts", () => {
  it("emails new approvals and failures once, with contact details masked", async () => {
    await pendingRefund();
    await failedRun(new Date(NOW.getTime() - 60_000));
    const resend = fakeResend();

    const outcome = await sendOwnerAlerts({ repo: t.repo, config: CONFIG, fetch: resend.fetchFn, now: () => NOW });
    expect(outcome).toMatchObject({ status: "done", results: [{ kind: "digest", items: 2, status: "sent", messageId: "msg_1" }] });

    const [email] = resend.sent;
    expect(email!.url).toBe("https://api.resend.com/emails");
    expect(email!.headers.Authorization).toBe("Bearer re_test");
    expect(email!.headers["Idempotency-Key"]).toMatch(/^alert:digest:[0-9a-f]{32}$/);
    expect(email!.body).toMatchObject({ from: CONFIG.from, to: ["owner@example.com"], subject: "Agent City: 1 approval waiting, 1 run failed" });
    const text = email!.body.text;
    expect(text).toContain("ParlayLab / BILLING-01: Refund $19.00 to j***@example.com ($19.00)");
    expect(text).toContain("Moves money.");
    expect(text).toContain("Stripe 401: invalid API key");
    expect(text).toContain("https://city.example.com");
    expect(text).not.toContain("jordan.lee");
    expect(text).not.toContain("555-0142");

    // Already notified: the next run has nothing to send.
    expect(await sendOwnerAlerts({ repo: t.repo, config: CONFIG, fetch: resend.fetchFn, now: () => NOW })).toEqual({ status: "nothing_new" });
    expect(resend.sent).toHaveLength(1);
    expect(await t.repo.lastNotification()).toMatchObject({ kind: "digest", status: "sent", item_count: 2, provider_message_id: "msg_1" });
  });

  it("emails HQ's brief as its own message", async () => {
    await t.repo.insertBrief("# Monday brief\n\n- 2 approvals waiting\n- Devlog crew ran", null);
    const resend = fakeResend();
    // The database stamps the brief with its own clock, so look back from the real time.
    const outcome = await sendOwnerAlerts({ repo: t.repo, config: CONFIG, fetch: resend.fetchFn });
    expect(outcome).toMatchObject({ status: "done", results: [{ kind: "brief", items: 1, status: "sent" }] });
    expect(resend.sent[0]!.body.subject).toMatch(/^HQ brief, \w{3}, \w{3} \d{1,2}: Monday brief$/);
    expect(resend.sent[0]!.body.text).toContain("- Devlog crew ran");
  });

  it("puts items back when the send fails, and retries them on the next run", async () => {
    const approval = await pendingRefund();
    const resend = fakeResend([500, 200]);

    const first = await sendOwnerAlerts({ repo: t.repo, config: CONFIG, fetch: resend.fetchFn, now: () => NOW });
    expect(first).toMatchObject({ status: "done", results: [{ status: "failed", error: "Resend 500: rate limited" }] });
    expect((await t.repo.getApproval(approval.id))?.notified_at).toBeNull();
    expect(await t.repo.lastNotification()).toMatchObject({ status: "failed", error: "Resend 500: rate limited" });

    const second = await sendOwnerAlerts({ repo: t.repo, config: CONFIG, fetch: resend.fetchFn, now: () => NOW });
    expect(second).toMatchObject({ status: "done", results: [{ status: "sent" }] });
    // Same items, same idempotency key: Resend would collapse a duplicate if the first had in fact gone out.
    expect(resend.sent[1]!.headers["Idempotency-Key"]).toBe(resend.sent[0]!.headers["Idempotency-Key"]);
    expect((await t.repo.getApproval(approval.id))?.notified_at).not.toBeNull();
  });

  it("claims nothing until it is configured", async () => {
    const approval = await pendingRefund();
    const config = alertConfigFromEnv({ ALERTS_EMAIL_TO: "owner@example.com" });
    expect(config).toEqual({ missing: ["ALERTS_RESEND_API_KEY", "ALERTS_EMAIL_FROM (or EMAIL_FROM)"] });

    const outcome = await sendOwnerAlerts({ repo: t.repo, config, now: () => NOW });
    expect(outcome).toEqual({ status: "not_configured", missing: ["ALERTS_RESEND_API_KEY", "ALERTS_EMAIL_FROM (or EMAIL_FROM)"] });
    expect((await t.repo.getApproval(approval.id))?.notified_at).toBeNull();
  });

  it("skips failures from before the last day, so a first deploy does not email old history", async () => {
    await failedRun(new Date(NOW.getTime() - 2 * 24 * 3_600_000));
    const resend = fakeResend();
    expect(await sendOwnerAlerts({ repo: t.repo, config: CONFIG, fetch: resend.fetchFn, now: () => NOW })).toEqual({ status: "nothing_new" });
    expect(resend.sent).toHaveLength(0);
  });

  it("reads its settings from the worker environment", () => {
    expect(
      alertConfigFromEnv({ ALERTS_RESEND_API_KEY: "re_x", ALERTS_EMAIL_TO: "owner@example.com", EMAIL_FROM: "Agent City <a@example.com>", CITY_URL: "https://c.example.com" }),
    ).toEqual({ resendApiKey: "re_x", to: "owner@example.com", from: "Agent City <a@example.com>", cityUrl: "https://c.example.com" });
  });
});

describe("redactContacts", () => {
  it("masks email addresses and phone numbers, and leaves amounts, dates and ids alone", () => {
    expect(redactContacts("Email jordan.lee@gmail.com about $1,234.56 due 2026-10-12 (cus_9XyZ, ch_123)")).toBe(
      "Email j***@gmail.com about $1,234.56 due 2026-10-12 (cus_9XyZ, ch_123)",
    );
    expect(redactContacts("Call (312) 555-0142 or +1 312.555.0142 or 312-555-0142")).toBe("Call [phone] or [phone] or [phone]");
  });
});
