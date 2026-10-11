import type { AgentRow } from "@agent-city/core";
import type { Repo } from "@agent-city/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineServiceTool, parseAppCredential, ToolError, UNTRUSTED_NOTICE, type ToolContext } from "../src";

// The outbound half of the company connector: typed tools that call a company
// app's agent API with the calling agent's own token.

const CREDENTIAL = JSON.stringify({ base_url: "https://fedops.example/api/agent/v1/", token: "fa_test_0123456789abcdef" });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestInit["redirect"];
}

/** A fake app: records each request and answers with the scripted status and body. */
function fakeApp(status = 200, body: unknown = { ok: true }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined, redirect: init.redirect });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function context(fetchFn: typeof fetch, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repo: {} as Repo,
    agent: { id: "fedops.capture-01", division_id: "fedops" } as AgentRow,
    runId: "0199a0c0-0000-7000-8000-000000000001",
    secret: CREDENTIAL,
    idempotencyKey: null,
    services: { fetch: fetchFn },
    now: () => new Date("2026-10-11T12:00:00Z"),
    ...overrides,
  };
}

const getPursuit = defineServiceTool({
  app: "fedops",
  name: "fedops.get_pursuit",
  description: "One pursuit with its scores and status.",
  tier: "read",
  method: "GET",
  path: "/pursuits/{pursuit_id}",
  schema: z.object({ pursuit_id: z.string().min(1), include: z.array(z.enum(["scores", "requirements"])).optional() }),
  describe: (a) => `Read pursuit ${a.pursuit_id}`,
});

const addNote = defineServiceTool({
  app: "fedops",
  name: "fedops.add_pursuit_note",
  description: "Add a capture note to a pursuit.",
  tier: "internal_write",
  method: "POST",
  path: "/pursuits/{pursuit_id}/notes",
  schema: z.object({ pursuit_id: z.string().min(1), note: z.string().min(1).max(2000) }),
  describe: (a) => `Note on ${a.pursuit_id}`,
});

describe("defineServiceTool", () => {
  it("calls the app's agent API with the agent's token and says who is asking", async () => {
    const app = fakeApp(200, { pursuit: { id: "PUR-2026-0004", fit: 82 } });
    const result = await getPursuit.execute({ pursuit_id: "PUR 2026/0004", include: ["scores", "requirements"] }, context(app.fetchFn));

    expect(getPursuit).toMatchObject({ integration: "fedops", tier: "read" });
    const [call] = app.calls;
    expect(call!.url).toBe("https://fedops.example/api/agent/v1/pursuits/PUR%202026%2F0004?include=scores&include=requirements");
    expect(call!.method).toBe("GET");
    expect(call!.redirect).toBe("error");
    expect(call!.headers).toMatchObject({
      Authorization: "Bearer fa_test_0123456789abcdef",
      "X-Agent-City-Agent": "fedops.capture-01",
      "X-Agent-City-Run": "0199a0c0-0000-7000-8000-000000000001",
    });
    expect(call!.headers["Idempotency-Key"]).toBeUndefined();
    // App data can carry outsiders' text (solicitations, messages), so it is marked as data.
    expect(result).toEqual({ app: "fedops", notice: UNTRUSTED_NOTICE, data: { pursuit: { id: "PUR-2026-0004", fit: 82 } } });
  });

  it("sends writes as JSON with an idempotency key that repeats for a retried call", async () => {
    const app = fakeApp(201, { note_id: "n1" });
    const args = { pursuit_id: "PUR-2026-0004", note: "Incumbent is a small business; recompete likely set aside." };
    await addNote.execute(args, context(app.fetchFn));
    await addNote.execute(args, context(app.fetchFn));
    await addNote.execute({ ...args, note: "Different note" }, context(app.fetchFn));
    await addNote.execute(args, context(app.fetchFn, { idempotencyKey: "approval-7" }));

    const [first, retry, other, approved] = app.calls;
    expect(first!.url).toBe("https://fedops.example/api/agent/v1/pursuits/PUR-2026-0004/notes");
    expect(first!.method).toBe("POST");
    expect(JSON.parse(first!.body!)).toEqual({ note: args.note });
    expect(first!.headers["Content-Type"]).toBe("application/json");
    expect(first!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{48}$/);
    expect(retry!.headers["Idempotency-Key"]).toBe(first!.headers["Idempotency-Key"]);
    expect(other!.headers["Idempotency-Key"]).not.toBe(first!.headers["Idempotency-Key"]);
    // An approved action executes under its approval id.
    expect(approved!.headers["Idempotency-Key"]).toBe("approval-7");
  });

  it("turns the app's refusals into errors the agent can act on, without leaking the token", async () => {
    const cases: [number, unknown, RegExp][] = [
      [401, { error: "invalid token" }, /FedOps refused fedops\.capture-01's token \(Vault agent:fedops\.capture-01:fedops\)/],
      [403, { message: "scope pursuits:write missing" }, /does not allow fedops\.capture-01 to do this: scope pursuits:write missing/],
      [404, "", /FedOps has no such record\./],
      [409, { message: "already noted" }, /already happened: already noted/],
      [422, { message: "note is too long" }, /FedOps rejected the request: note is too long/],
      [429, {}, /rate limiting/],
      [503, "upstream down", /FedOps failed with 503: upstream down/],
    ];
    for (const [status, body, message] of cases) {
      const app = fakeApp(status, body);
      const error = await addNote.execute({ pursuit_id: "PUR-1", note: "x" }, context(app.fetchFn)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).message).toMatch(message);
      expect((error as ToolError).message).not.toContain("fa_test_");
    }
  });

  it("refuses oversized and non-JSON answers, and reports an app that does not answer", async () => {
    const huge = fakeApp(200, { blob: "x".repeat(250_000) });
    await expect(getPursuit.execute({ pursuit_id: "P" }, context(huge.fetchFn))).rejects.toThrow(/Ask for less/);
    const html = fakeApp(200, "<html>login</html>");
    await expect(getPursuit.execute({ pursuit_id: "P" }, context(html.fetchFn))).rejects.toThrow(/not JSON/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(getPursuit.execute({ pursuit_id: "P" }, context(down))).rejects.toMatchObject({ code: "fedops_unreachable" });
  });

  it("checks its own definition when it is declared", () => {
    const base = { app: "fedops" as const, description: "x", tier: "read" as const, method: "GET" as const, describe: () => "x" };
    expect(() => defineServiceTool({ ...base, name: "halo.read", path: "/x", schema: z.object({}) })).toThrow(/must be named fedops\./);
    expect(() => defineServiceTool({ ...base, name: "fedops.read", path: "/x/{id}", schema: z.object({}) })).toThrow(/\{id\} is not in its schema/);
  });
});

describe("parseAppCredential", () => {
  it("wants https and a real token, and names the Vault secret when either is missing", () => {
    expect(parseAppCredential(CREDENTIAL, "a", "fedops")).toEqual({ base_url: "https://fedops.example/api/agent/v1", token: "fa_test_0123456789abcdef" });
    expect(parseAppCredential(JSON.stringify({ base_url: "http://localhost:3000/api/agent/v1", token: "fa_test_0123456789abcdef" }), "a", "fedops").base_url).toBe(
      "http://localhost:3000/api/agent/v1",
    );

    expect(() => parseAppCredential(null, "fedops.capture-01", "fedops")).toThrow(/agent:fedops\.capture-01:fedops/);
    expect(() => parseAppCredential("fa_plain_token", "a", "fedops")).toThrow(/not JSON/);
    for (const base_url of ["http://fedops.example/api", "https://user:pw@fedops.example/api", "https://fedops.example/api?x=1", "ftp://fedops.example", "nope"]) {
      expect(() => parseAppCredential(JSON.stringify({ base_url, token: "fa_test_0123456789abcdef" }), "a", "fedops")).toThrow(/https:\/\//);
    }
    expect(() => parseAppCredential(JSON.stringify({ base_url: "https://fedops.example", token: "short" }), "a", "fedops")).toThrow(/16 characters/);
  });
});
