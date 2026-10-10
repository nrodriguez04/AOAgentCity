import { createTestDatabase, insertFixtures, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoke, type GatewayContext } from "../src";

// The tools crews use: drafts, division reads and read-only GitHub.

let t: TestDatabase;
let billing: GatewayContext;

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.repo.replacePermissions("parlaylab.billing-01", [
    { tool_name: "draft.save", max_tier: "internal_write" },
    { tool_name: "drafts.recent", max_tier: "read" },
    { tool_name: "division.get", max_tier: "read" },
    { tool_name: "github.list_commits", max_tier: "read" },
  ]);
  billing = { repo: t.repo, agent: (await t.repo.getAgent("parlaylab.billing-01"))!, runId: null };
});

afterEach(async () => {
  await t.close();
});

describe("draft tools", () => {
  it("saves a draft in the agent's own division and announces it without changing the agent's state", async () => {
    const result = await invoke(billing, "draft.save", { kind: "social_post", channel: "x", title: "Week 3 recap", body_md: "We shipped **dunning**." });
    expect(result).toMatchObject({ status: "ok", result: { draft_id: expect.any(String) } });

    const [draft] = await t.repo.listDrafts({ divisionId: "parlaylab" });
    expect(draft).toMatchObject({ agent_id: "parlaylab.billing-01", kind: "social_post", channel: "x", status: "draft", body_md: "We shipped **dunning**." });
    const [event] = await t.repo.listEvents({ divisionId: "parlaylab" });
    expect(event).toMatchObject({ type: "run.progress", summary: "Draft ready: Week 3 recap", payload: { draft_id: draft!.id } });
    expect((await t.repo.getAgent("parlaylab.billing-01"))?.state).toBe("idle");
  });

  it("rejects kinds outside the contract", async () => {
    expect(await invoke(billing, "draft.save", { kind: "tweetstorm", title: "x", body_md: "y" })).toMatchObject({ error: "invalid_args" });
    expect(await t.repo.listDrafts()).toHaveLength(0);
  });

  it("lists recent drafts with short excerpts", async () => {
    await invoke(billing, "draft.save", { kind: "report", title: "Weekly review", body_md: "x".repeat(1_000) });
    const result = await invoke(billing, "drafts.recent", { division_id: "parlaylab" });
    expect(result).toMatchObject({ status: "ok" });
    const drafts = (result as { result: { drafts: { title: string; excerpt: string }[] } }).result.drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.excerpt).toHaveLength(280);
  });

  it("reads a division with its context doc and metrics", async () => {
    await t.repo.updateDivisionContext("parlaylab", "# ParlayLab\nSubscriptions.");
    const result = await invoke(billing, "division.get", { division_id: "parlaylab" });
    expect(result).toMatchObject({ status: "ok", result: { id: "parlaylab", status: "live", context_md: "# ParlayLab\nSubscriptions.", metrics: {} } });
    expect(await invoke(billing, "division.get", { division_id: "nope" })).toMatchObject({ error: "not_found" });
  });
});

describe("github.list_commits", () => {
  const commit = (sha: string, message: string, parents = 1) => ({
    sha,
    html_url: `https://github.com/o/r/commit/${sha}`,
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
    commit: { message, author: { name: "Nico", date: "2026-10-09T18:00:00Z" } },
  });

  it("needs the agent's own token", async () => {
    expect(await invoke(billing, "github.list_commits", { repo: "nrodriguez04/AOWorld" })).toMatchObject({ error: "missing_credential" });
  });

  it("lists commits with the agent's token and marks merges", async () => {
    await t.setSecret("agent:parlaylab.billing-01:github", "github_pat_test");
    const requests: { url: string; auth: string }[] = [];
    const fetch = (async (input: URL | string, init?: RequestInit) => {
      requests.push({ url: String(input), auth: (init?.headers as Record<string, string>).Authorization! });
      return new Response(JSON.stringify([commit("abcdef1234", "Add the employment loop\n\nResidents can be hired."), commit("1234567890", "Merge pull request #9", 2)]));
    }) as typeof globalThis.fetch;
    const ctx = { ...billing, services: { fetch }, now: () => new Date("2026-10-10T00:00:00Z") };
    const result = await invoke(ctx, "github.list_commits", { repo: "nrodriguez04/AOWorld", days: 7 });

    expect(result).toMatchObject({ status: "ok" });
    const listed = (result as { result: { commits: { sha: string; merge: boolean; message: string }[] } }).result.commits;
    expect(listed).toEqual([
      expect.objectContaining({ sha: "abcdef1", merge: false, message: "Add the employment loop\n\nResidents can be hired." }),
      expect.objectContaining({ sha: "1234567", merge: true }),
    ]);
    expect(requests[0]!.auth).toBe("Bearer github_pat_test");
    expect(requests[0]!.url).toContain("https://api.github.com/repos/nrodriguez04/AOWorld/commits?since=2026-10-03T00%3A00%3A00.000Z");
  });

  it("reports GitHub errors to the caller", async () => {
    await t.setSecret("agent:parlaylab.billing-01:github", "bad");
    const fetch = (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof globalThis.fetch;
    expect(await invoke({ ...billing, services: { fetch } }, "github.list_commits", { repo: "o/r" })).toMatchObject({ error: "github_401" });
  });
});
