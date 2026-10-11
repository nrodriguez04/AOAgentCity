import { createTestDatabase, insertFixtures, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoke, type GatewayContext } from "../src";

// The knowledge store: per-division documents that agents search, read and
// (for their own notes) write. Nico's documents are his.

let t: TestDatabase;
let billing: GatewayContext;
let hq: GatewayContext;
const OWNER = "11111111-1111-4111-8111-111111111111";

const KNOWLEDGE = [
  { tool_name: "knowledge.search", max_tier: "read" as const },
  { tool_name: "knowledge.get", max_tier: "read" as const },
  { tool_name: "knowledge.save", max_tier: "internal_write" as const },
];

beforeEach(async () => {
  t = await createTestDatabase();
  await insertFixtures(t);
  await t.repo.replacePermissions("parlaylab.billing-01", KNOWLEDGE);
  await t.repo.replacePermissions("hq.hq-01", KNOWLEDGE.slice(0, 2));
  billing = { repo: t.repo, agent: (await t.repo.getAgent("parlaylab.billing-01"))!, runId: null };
  hq = { repo: t.repo, agent: (await t.repo.getAgent("hq.hq-01"))!, runId: null };
  await t.sql.query(`insert into owners (user_id, note) values ($1, 'nico')`, [OWNER]);
  // Nico's documents, written in the city.
  await t.asUser(OWNER, (sql) =>
    sql.query(
      `insert into documents (division_id, slug, title, body_md, tags) values
         ('parlaylab', 'refund-policy', 'Refund policy', 'Refund double charges in full within 7 days. Never refund to win back a customer.', '{billing,refunds}'),
         ('hq', 'priorities', 'Q4 priorities', 'FedOps first: deploy it and connect it to Agent City.', '{planning}')`,
    ),
  );
});

afterEach(async () => {
  await t.close();
});

const results = (r: unknown) => (r as { result: { results: { slug: string; excerpt: string; division_id: string }[] } }).result.results;

describe("knowledge tools", () => {
  it("finds documents by meaning-bearing words, with highlighted excerpts", async () => {
    const r = await invoke(billing, "knowledge.search", { query: "double charge refund" });
    expect(r).toMatchObject({ status: "ok" });
    const [hit] = results(r);
    expect(hit).toMatchObject({ division_id: "parlaylab", slug: "refund-policy" });
    expect(hit!.excerpt).toContain("**");

    const doc = await invoke(billing, "knowledge.get", { slug: "refund-policy" });
    expect(doc).toMatchObject({ status: "ok", result: { title: "Refund policy", version: 1, updated_by: "owner", truncated: false } });
  });

  it("keeps division agents inside their division, and lets HQ read across", async () => {
    expect(results(await invoke(billing, "knowledge.search", { query: "FedOps priorities" }))).toEqual([]);
    expect(await invoke(billing, "knowledge.search", { query: "priorities", division_id: "hq" })).toMatchObject({ error: "out_of_scope" });
    expect(await invoke(billing, "knowledge.get", { slug: "priorities", division_id: "hq" })).toMatchObject({ error: "out_of_scope" });

    expect(results(await invoke(hq, "knowledge.search", { query: "refund" })).map((d) => d.slug)).toEqual(["refund-policy"]);
    expect(await invoke(hq, "knowledge.get", { slug: "refund-policy", division_id: "parlaylab" })).toMatchObject({ status: "ok" });
  });

  it("saves agent notes with version history, and never overwrites Nico's documents", async () => {
    const first = await invoke(billing, "knowledge.save", { slug: "dunning-lessons", title: "Dunning lessons", body_md: "Friday emails get fewer replies.", tags: ["billing"] });
    expect(first).toMatchObject({ status: "ok", result: { slug: "dunning-lessons", version: 1 } });
    const second = await invoke(billing, "knowledge.save", { slug: "dunning-lessons", title: "Dunning lessons", body_md: "Friday and Saturday emails get fewer replies." });
    expect(second).toMatchObject({ status: "ok", result: { version: 2 } });
    const [old] = await t.sql.query<{ version: number; body_md: string; updated_by: string }>(`select version, body_md, updated_by from document_versions`);
    expect(old).toEqual({ version: 1, body_md: "Friday emails get fewer replies.", updated_by: "parlaylab.billing-01" });

    const refused = await invoke(billing, "knowledge.save", { slug: "refund-policy", title: "Refund policy", body_md: "Refund anything." });
    expect(refused).toMatchObject({ error: "owned_by_nico" });
    expect((await t.repo.getDocument("parlaylab", "refund-policy"))?.body_md).toContain("Never refund to win back a customer.");

    const [event] = await t.repo.listEvents({ divisionId: "parlaylab" });
    expect(event).toMatchObject({ type: "run.progress", summary: "Knowledge saved: Dunning lessons" });
  });

  it("lets Nico edit and archive in the city; the browser cannot pose as an agent or delete", async () => {
    await t.asUser(OWNER, (sql) => sql.query(`update documents set body_md = 'Refund double charges within 14 days.' where slug = 'refund-policy'`));
    const doc = await t.repo.getDocument("parlaylab", "refund-policy");
    expect(doc).toMatchObject({ version: 2, updated_by: "owner" });

    await expect(t.asUser(OWNER, (sql) => sql.query(`update documents set updated_by = 'hq.hq-01' where slug = 'refund-policy'`))).rejects.toThrow(/permission denied/);
    await expect(t.asUser(OWNER, (sql) => sql.query(`delete from documents where slug = 'refund-policy'`))).rejects.toThrow(/permission denied/);

    await t.asUser(OWNER, (sql) => sql.query(`update documents set archived = true where slug = 'refund-policy'`));
    expect(results(await invoke(billing, "knowledge.search", { query: "refund" }))).toEqual([]);
    expect(await invoke(billing, "knowledge.get", { slug: "refund-policy" })).toMatchObject({ error: "not_found" });
  });
});
