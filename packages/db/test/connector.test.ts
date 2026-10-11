import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, insertFixtures, type TestDatabase } from "../src/testing";

// The inbound half of the company connector: ingest_app_event() verifies an
// app's HMAC signature against its Vault secret, then writes the event and
// mirrors the app's approvals. See docs/CONNECTOR.md.

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-signing-secret-fedops";

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.db.exec(`
    insert into divisions (id, name, kind, status) values
      ('fedops', 'FedOps', 'business', 'planning'),
      ('halo', 'Hålo', 'business', 'planned');
  `);
  await t.sql.query(`insert into owners (user_id, note) values ($1, 'nico')`, [OWNER]);
  await t.setSecret("app:fedops:events", SECRET);
});

afterEach(async () => {
  await t.close();
});

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sign = (secret: string, timestamp: number, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

/** Call ingest_app_event the way the Edge Function does: as the service role. */
async function ingest(
  body: unknown,
  opts: { app?: string; timestamp?: number; secret?: string; signature?: string; role?: string } = {},
): Promise<{ status: string; event_id?: number }> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = opts.timestamp ?? nowSeconds();
  const signature = opts.signature ?? sign(opts.secret ?? SECRET, timestamp, raw);
  return t.db.transaction(async (tx) => {
    await tx.exec(`set local role ${opts.role ?? "service_role"}`);
    const result = await tx.query<{ r: { status: string; event_id?: number } }>(
      `select public.ingest_app_event($1, $2, $3, $4) as r`,
      [opts.app ?? "fedops", timestamp, signature, raw],
    );
    return result.rows[0]!.r;
  });
}

const qualified = {
  id: "evt_01",
  type: "fedops.opportunity.qualified",
  summary: "Janitorial services, VA Dallas: fit 82, eligible",
  level: "success",
  occurred_at: "2026-10-11T12:00:00Z",
  payload: { pursuit: "PUR-2026-0004", fit: 82 },
};

describe("ingest_app_event", () => {
  it("accepts a signed event into the app's division and remembers its id", async () => {
    const result = await ingest(qualified);
    expect(result).toMatchObject({ status: "accepted" });

    const [event] = await t.sql.query<Record<string, unknown>>(`select * from events where id = $1`, [result.event_id]);
    expect(event).toMatchObject({
      division_id: "fedops",
      agent_id: null,
      type: "fedops.opportunity.qualified",
      level: "success",
      summary: "Janitorial services, VA Dallas: fit 82, eligible",
      payload: { pursuit: "PUR-2026-0004", fit: 82, app: "fedops", external_id: "evt_01", occurred_at: "2026-10-11T12:00:00Z" },
    });

    // The owner sees it in the city like any other event.
    const seen = await t.asUser(OWNER, (sql) => sql.query<{ type: string }>(`select type from events`));
    expect(seen).toEqual([{ type: "fedops.opportunity.qualified" }]);
  });

  it("treats a retried event id as a duplicate, even with a fresh signature", async () => {
    await ingest(qualified);
    expect(await ingest(qualified, { timestamp: nowSeconds() + 1 })).toEqual({ status: "duplicate" });
    expect(await t.sql.query(`select id from events`)).toHaveLength(1);
  });

  it("rejects a wrong signature, a wrong secret and an app that is not connected the same way", async () => {
    await expect(ingest(qualified, { signature: "sha256=00" })).rejects.toThrow(/signature rejected/);
    await expect(ingest(qualified, { secret: "not-the-secret" })).rejects.toThrow(/signature rejected/);
    await expect(ingest({ ...qualified, type: "halo.lead.created" }, { app: "halo" })).rejects.toThrow(/signature rejected/);

    // A body changed after signing fails too.
    const timestamp = nowSeconds();
    const signature = sign(SECRET, timestamp, JSON.stringify(qualified));
    await expect(ingest({ ...qualified, summary: "Tampered" }, { timestamp, signature })).rejects.toThrow(/signature rejected/);
    expect(await t.sql.query(`select id from events`)).toHaveLength(0);
  });

  it("rejects stale timestamps, unknown apps and oversized bodies before anything else", async () => {
    await expect(ingest(qualified, { timestamp: nowSeconds() - 600 })).rejects.toThrow(/5 minutes/);
    await expect(ingest(qualified, { app: "evilcorp" })).rejects.toThrow(/unknown app/);
    await expect(ingest({ ...qualified, payload: { blob: "x".repeat(70_000) } })).rejects.toThrow(/64 KB/);
  });

  it("only accepts event types in the app's own namespace, and well-formed bodies", async () => {
    for (const type of ["halo.lead.created", "run.succeeded", "fedops.Bad.Case", "fedops.one", "fedops.a.b.c.d.e"]) {
      await expect(ingest({ ...qualified, id: `evt_${type}`, type })).rejects.toThrow(/namespace/);
    }
    await expect(ingest("not json")).rejects.toThrow(/not JSON/);
    await expect(ingest({ ...qualified, id: "" })).rejects.toThrow(/id is required/);
    await expect(ingest({ ...qualified, summary: "" })).rejects.toThrow(/summary is required/);
    await expect(ingest({ ...qualified, payload: [1, 2] })).rejects.toThrow(/payload must be an object/);
    await expect(ingest({ ...qualified, level: "critical" })).rejects.toThrow(/level must be/);

    // Four segments are allowed: <app>.<subject>.<detail>.<verb>.
    expect(await ingest({ ...qualified, id: "evt_4", type: "fedops.pursuit.stage.changed" })).toMatchObject({ status: "accepted" });
  });

  it("is callable by the service role only", async () => {
    for (const role of ["authenticated", "anon"]) {
      await expect(ingest(qualified, { role })).rejects.toThrow(/permission denied/);
    }
    // And nobody in the browser can read the receipts.
    await ingest(qualified);
    await expect(t.asUser(OWNER, (sql) => sql.query(`select * from app_event_receipts`))).rejects.toThrow(/permission denied/);
  });

  it("keeps the event contract for everything else", async () => {
    const insert = (type: string) =>
      t.sql.query(`insert into events (division_id, type, summary) values ('fedops', $1, 'x')`, [type]);
    await insert("fedops.contract.awarded");
    await expect(insert("evil.thing.happened")).rejects.toThrow(/events_type_check/);
    await expect(insert("run.exploded")).rejects.toThrow(/events_type_check/);
  });
});

describe("mirrored app approvals", () => {
  const requested = {
    id: "evt_10",
    type: "fedops.approval.requested",
    summary: "Bid decision: Janitorial services, VA Dallas",
    level: "warning",
    approval: {
      id: "APV-2026-0004",
      title: "Bid decision: Janitorial services, VA Dallas",
      risk: "external_effect",
      url: "https://fedops.example/approvals/APV-2026-0004",
      status: "pending",
      requested_at: "2026-10-11T12:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
    },
  };

  it("mirrors an app's approval for the owner to see, never to decide", async () => {
    await ingest(requested);
    const [row] = await t.repo.listAppApprovals();
    expect(row).toMatchObject({
      app: "fedops",
      external_id: "APV-2026-0004",
      division_id: "fedops",
      risk: "external_effect",
      status: "pending",
      url: "https://fedops.example/approvals/APV-2026-0004",
      notified_at: null,
    });

    expect(await t.asUser(OWNER, (sql) => sql.query(`select external_id from app_approvals`))).toEqual([{ external_id: "APV-2026-0004" }]);
    expect(await t.asUser(STRANGER, (sql) => sql.query(`select external_id from app_approvals`))).toEqual([]);
    await expect(
      t.asUser(OWNER, (sql) => sql.query(`update app_approvals set status = 'approved'`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("updates the mirror when the app decides, and alerts once per open approval", async () => {
    await ingest(requested);
    const claimed = await t.repo.claimUnnotifiedAppApprovals();
    expect(claimed.map((a) => a.external_id)).toEqual(["APV-2026-0004"]);
    expect(await t.repo.claimUnnotifiedAppApprovals()).toEqual([]);

    // A failed email puts it back in the queue.
    await t.repo.releaseNotificationClaims({ appApprovals: claimed });
    expect(await t.repo.claimUnnotifiedAppApprovals()).toHaveLength(1);

    await ingest({
      ...requested,
      id: "evt_11",
      type: "fedops.approval.decided",
      summary: "Bid decision approved",
      level: "info",
      approval: { ...requested.approval, status: "approved", decided_at: "2026-10-11T13:00:00Z" },
    });
    expect(await t.repo.listAppApprovals()).toEqual([]);
    const [decided] = await t.repo.listAppApprovals({ includeClosed: true });
    expect(decided).toMatchObject({ status: "approved", decided_at: "2026-10-11T13:00:00.000Z", notified_at: null });
  });

  it("refuses approvals with unsafe links or unknown risk", async () => {
    await expect(ingest({ ...requested, approval: { ...requested.approval, url: "javascript:alert(1)" } })).rejects.toThrow(/app_approvals_url_check/);
    await expect(ingest({ ...requested, id: "evt_12", approval: { ...requested.approval, risk: "harmless" } })).rejects.toThrow(/app_approvals_risk_check/);
    await expect(ingest({ ...requested, id: "evt_13", approval: "yes" })).rejects.toThrow(/approval must be an object/);
    // A rejected body leaves nothing behind, not even a receipt, so the app can fix it and resend.
    expect(await t.sql.query(`select * from app_event_receipts`)).toEqual([]);
  });
});

describe("app-events Edge Function", () => {
  const SUPABASE_URL = "https://project.supabase.co";

  /** Stands in for PostgREST: runs the RPC on the test database as the service role, with PostgREST's error shape. */
  function fakePostgrest() {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      const args = JSON.parse(String(init.body)) as { p_app: string; p_timestamp: number; p_signature: string; p_body: string };
      try {
        const result = await t.db.transaction(async (tx) => {
          await tx.exec(`set local role service_role`);
          const rows = await tx.query<{ r: unknown }>(`select public.ingest_app_event($1, $2, $3, $4) as r`, [args.p_app, args.p_timestamp, args.p_signature, args.p_body]);
          return rows.rows[0]!.r;
        });
        return Response.json(result);
      } catch (error) {
        const { code, message } = error as { code?: string; message: string };
        return Response.json({ code, message, details: null, hint: null }, { status: code === "28000" ? 403 : 400 });
      }
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }

  function post(body: string | Uint8Array, headers: Record<string, string>) {
    return new Request(`${SUPABASE_URL}/functions/v1/app-events`, { method: "POST", body, headers });
  }

  function signed(event: unknown, app = "fedops", secret = SECRET) {
    const body = JSON.stringify(event);
    const timestamp = nowSeconds();
    return post(body, {
      "Content-Type": "application/json",
      "X-Agent-City-App": app,
      "X-Agent-City-Timestamp": String(timestamp),
      "X-Agent-City-Signature": sign(secret, timestamp, body),
    });
  }

  async function handler() {
    const { createHandler } = await import("../../../supabase/functions/app-events/handler");
    const postgrest = fakePostgrest();
    const logs: string[] = [];
    const handle = createHandler({ supabaseUrl: `${SUPABASE_URL}/`, serviceHeaders: { apikey: "sb_secret_test" }, fetch: postgrest.fetchFn, log: (l) => logs.push(l) });
    return { handle, postgrest, logs };
  }

  it("stores a signed event once and answers duplicates as success", async () => {
    const { handle, postgrest, logs } = await handler();
    const first = await handle(signed(qualified));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: "accepted", event_id: expect.any(Number) });
    expect(postgrest.seen[0]).toMatchObject({ url: `${SUPABASE_URL}/rest/v1/rpc/ingest_app_event`, headers: { apikey: "sb_secret_test" } });

    const again = await handle(signed(qualified));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(logs).toEqual(["app-events: fedops accepted", "app-events: fedops duplicate"]);
  });

  it("answers bad signatures with 401 and bad events with 422, without storing either", async () => {
    const { handle, logs } = await handler();
    const forged = await handle(signed(qualified, "fedops", "guessed-secret"));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "unauthorized", message: "signature rejected" });

    const wrongNamespace = await handle(signed({ ...qualified, type: "halo.lead.created" }));
    expect(wrongNamespace.status).toBe(422);
    expect(await wrongNamespace.json()).toMatchObject({ error: "invalid_event", message: expect.stringMatching(/namespace/) });

    expect(await t.sql.query(`select id from events`)).toHaveLength(0);
    // Logs name the app and the outcome, never the body or the signature.
    expect(logs).toEqual(["app-events: fedops signature rejected"]);
  });

  it("turns away malformed requests before they reach the database", async () => {
    const { handle, postgrest } = await handler();
    const timestamp = String(nowSeconds());
    const headers = { "X-Agent-City-App": "fedops", "X-Agent-City-Timestamp": timestamp, "X-Agent-City-Signature": `sha256=${"0".repeat(64)}` };

    expect((await handle(new Request(`${SUPABASE_URL}/functions/v1/app-events`))).status).toBe(405);
    expect((await handle(post("{}", { ...headers, "X-Agent-City-App": "evilcorp" }))).status).toBe(400);
    expect((await handle(post("{}", { ...headers, "X-Agent-City-Timestamp": "yesterday" }))).status).toBe(400);
    expect((await handle(post("{}", { ...headers, "X-Agent-City-Signature": "md5=abc" }))).status).toBe(401);
    expect((await handle(post("x".repeat(70_000), headers))).status).toBe(413);
    expect((await handle(post(new Uint8Array([0x7b, 0xff, 0x7d]), headers))).status).toBe(400);
    expect(postgrest.seen).toHaveLength(0);
  });

  it("authenticates with the project's secret key, or the legacy service key", async () => {
    const { serviceHeadersFromEnv } = await import("../../../supabase/functions/app-events/handler");
    const env = (vars: Record<string, string>) => (name: string) => vars[name];
    expect(serviceHeadersFromEnv(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}', SUPABASE_SERVICE_ROLE_KEY: "eyJ.legacy" }))).toEqual({ apikey: "sb_secret_x" });
    expect(serviceHeadersFromEnv(env({ SUPABASE_SERVICE_ROLE_KEY: "eyJ.legacy" }))).toEqual({ apikey: "eyJ.legacy", Authorization: "Bearer eyJ.legacy" });
    expect(() => serviceHeadersFromEnv(env({}))).toThrow(/no service key/);
  });
});
