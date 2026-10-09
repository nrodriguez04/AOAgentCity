import { readFileSync } from "node:fs";
import { requiresApproval } from "@agent-city/core";
import { createTestDatabase, SUPABASE_DIR } from "@agent-city/db/testing";
import { getTool } from "@agent-city/tools";
import { describe, expect, it } from "vitest";
import { AGENTS, permissionsFor, seedSql, syncToDatabase } from "../src";

describe("agent definitions", () => {
  it("defines HQ-01 and the three ParlayLab agents", () => {
    expect(AGENTS.map((a) => a.displayName)).toEqual(["HQ-01", "BILLING-01", "SUPPORT-01", "GROWTH-01"]);
  });

  it("keeps HQ free of external side effects (spec §6.3)", () => {
    const hq = AGENTS.find((a) => a.id === "hq.hq-01")!;
    expect(hq.tools.filter((name) => requiresApproval(getTool(name)!.tier))).toEqual([]);
    expect(hq.modelTier).toBe("reasoning");
  });

  it("routes BILLING-01's refunds and emails through the approval tiers", () => {
    const billing = AGENTS.find((a) => a.id === "parlaylab.billing-01")!;
    const grants = Object.fromEntries(permissionsFor(billing).map((p) => [p.tool_name, p.max_tier]));
    expect(grants["stripe.issue_refund"]).toBe("financial");
    expect(grants["email.send"]).toBe("external_effect");
    expect(grants["stripe.list_subscriptions"]).toBe("read");
  });

  it("gives every agent instructions with an objective, limits and an output format", () => {
    for (const agent of AGENTS) {
      expect(agent.instructions).toMatch(/## (Objective|Each run)/);
      expect(agent.instructions).toMatch(/## Hard limits/);
      expect(agent.instructions.length).toBeGreaterThan(800);
      expect(agent.defaultGoal.length).toBeGreaterThan(40);
    }
  });
});

describe("seed", () => {
  it("is up to date with the definitions (run `pnpm gen:seed` if this fails)", () => {
    expect(readFileSync(`${SUPABASE_DIR}seed.sql`, "utf8")).toBe(seedSql(AGENTS));
  });

  it("applies cleanly on top of the migrations, and again", async () => {
    const t = await createTestDatabase({ seed: true });
    try {
      await t.db.exec(readFileSync(`${SUPABASE_DIR}seed.sql`, "utf8"));
      const [counts] = await t.sql.query<Record<string, number>>(`
        select (select count(*) from divisions)::int as divisions,
               (select count(*) from agents)::int as agents,
               (select count(*) from agent_permissions)::int as permissions,
               (select count(*) from model_pricing)::int as pricing`);
      const expectedPermissions = AGENTS.reduce((n, a) => n + a.tools.length, 0);
      expect(counts).toEqual({ divisions: 9, agents: 4, permissions: expectedPermissions, pricing: 5 });
      const hq = await t.repo.getDivision("hq");
      expect(hq?.city_slot).toMatchObject({ buildingModel: "deco-spire" });
      expect((await t.repo.getAgent("parlaylab.billing-01"))?.instructions).toContain("BILLING-01");
    } finally {
      await t.close();
    }
  });

  it("matches what agents:sync writes", async () => {
    const seeded = await createTestDatabase({ seed: true });
    const synced = await createTestDatabase();
    try {
      await syncToDatabase(synced.repo);
      const snapshot = async (sql: typeof seeded.sql) => ({
        agents: await sql.query(`select id, division_id, display_name, role, model_tier, instructions, default_goal, schedule_cron, daily_budget_usd::text, enabled, state from agents order by id`),
        permissions: await sql.query(`select * from agent_permissions order by agent_id, tool_name`),
        divisions: await sql.query(`select id, name, kind, status, summary, context_md, city_slot from divisions order by id`),
      });
      expect(await snapshot(synced.sql)).toEqual(await snapshot(seeded.sql));
    } finally {
      await seeded.close();
      await synced.close();
    }
  });
});
