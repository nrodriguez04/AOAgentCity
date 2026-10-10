import { readdirSync, readFileSync } from "node:fs";
import { CrewResult, type AgentRow, type CrewIO } from "@agent-city/core";
import { requiresApproval } from "@agent-city/core";
import { createTestDatabase, SUPABASE_DIR } from "@agent-city/db/testing";
import { getTool } from "@agent-city/tools";
import { describe, expect, it } from "vitest";
import { AGENTS, CREWS, CREW_OUTPUT_TOOLS, isCrew, permissionsFor, seedSql, syncToDatabase } from "../src";
import { CREW_SPECS } from "../src/crew-specs";

describe("agent definitions", () => {
  it("defines HQ-01, the three ParlayLab agents and three crews", () => {
    expect(AGENTS.filter((a) => !isCrew(a)).map((a) => a.displayName)).toEqual(["HQ-01", "BILLING-01", "SUPPORT-01", "GROWTH-01"]);
    expect(CREWS.map((c) => [c.id, c.runtime, c.project])).toEqual([
      ["averageoutput.devlog-crew", "crewai", "crews/devlog"],
      ["creatoros.content-crew", "crewai", "crews/content"],
      ["parlaylab.review-crew", "crewai", "crews/review"],
    ]);
  });

  it("keeps crews read-only apart from handing back drafts, tasks and metrics", () => {
    for (const crew of CREWS) {
      const writes = permissionsFor(crew).filter((p) => p.max_tier !== "read").map((p) => p.tool_name);
      expect(writes.sort()).toEqual([...CREW_OUTPUT_TOOLS].sort());
      expect(crew.instructions).toMatch(/## Job/);
      expect(crew.instructions).toMatch(/## Limits/);
      expect(crew.tasks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("gives the worker the same crew specs as the definitions, without reading files", () => {
    expect([...CREW_SPECS.keys()]).toEqual(CREWS.map((c) => c.id));
    for (const crew of CREWS) {
      const spec = CREW_SPECS.get(crew.id)!;
      expect([spec.project, spec.tasks, spec.buildInputs]).toEqual([crew.project, crew.tasks, crew.buildInputs]);
    }
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

  it("gives every Claude agent instructions with an objective, limits and an output format", () => {
    for (const agent of AGENTS.filter((a) => !isCrew(a))) {
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
      expect(counts).toEqual({ divisions: 9, agents: AGENTS.length, permissions: expectedPermissions, pricing: 5 });
      const hq = await t.repo.getDivision("hq");
      expect(hq?.city_slot).toMatchObject({ buildingModel: "deco-spire" });
      expect((await t.repo.getAgent("parlaylab.billing-01"))?.instructions).toContain("BILLING-01");
      expect(await t.repo.getAgent("averageoutput.devlog-crew")).toMatchObject({ runtime: "crewai", state: "idle" });
      expect((await t.repo.getAgent("hq.hq-01"))?.runtime).toBe("claude");
    } finally {
      await t.close();
    }
  });

  it("parks a disabled agent that was running, and wakes it again when re-enabled", async () => {
    const t = await createTestDatabase({ seed: true });
    try {
      const parked = AGENTS.find((a) => !a.enabled);
      expect(parked, "at least one agent is parked").toBeDefined();
      // A database seeded before the agent was parked: enabled and idle.
      await t.sql.query(`update agents set enabled = true, state = 'idle' where id = $1`, [parked!.id]);
      await t.db.exec(readFileSync(`${SUPABASE_DIR}seed.sql`, "utf8"));
      expect(await t.repo.getAgent(parked!.id)).toMatchObject({ enabled: false, state: "disabled" });

      await t.db.exec(seedSql(AGENTS.map((a) => (a.id === parked!.id ? { ...a, enabled: true } : a))));
      expect(await t.repo.getAgent(parked!.id)).toMatchObject({ enabled: true, state: "idle" });
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
        agents: await sql.query(`select id, division_id, display_name, role, model_tier, runtime, instructions, default_goal, schedule_cron, daily_budget_usd::text, enabled, state from agents order by id`),
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

describe("crews/ (the CrewAI projects)", () => {
  const ROOT = new URL("../../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
  const packageDir = (project: string) => {
    const [name] = readdirSync(new URL(`${project}/src/`, ROOT)).filter((d) => d.endsWith("_crew"));
    return `${project}/src/${name}`;
  };

  /** Canned read-tool results, enough for every crew to build real inputs. */
  const io: CrewIO = {
    agent: { id: "test.crew" } as AgentRow,
    now: () => new Date("2026-10-09T20:00:00Z"),
    async call<T>(tool: string): Promise<T> {
      const results: Record<string, unknown> = {
        "github.list_commits": {
          repo: "nrodriguez04/AOWorld",
          since: "2026-10-02T20:00:00Z",
          truncated: false,
          commits: [{ sha: "eabdbda", date: "2026-10-07T18:00:00Z", author: "Nico", merge: false, message: "Employment: a city can hire the people who live in it", url: "" }],
        },
        "division.get": { id: "x", name: "X", status: "live", summary: null, metrics: { mrr: { value: 4210, unit: "usd" } }, context_md: "# X" },
        "events.recent": { events: [{ ts: "2026-10-08T12:00:00Z", division_id: "parlaylab", agent_id: "parlaylab.growth-01", type: "metric.updated", level: "info", summary: "MRR $4,210" }] },
        "drafts.recent": { drafts: [] },
        "task.list": { tasks: [] },
      };
      return results[tool] as T;
    },
  };

  it("share one result contract, matching CrewResult in packages/core", () => {
    const files = CREWS.map((c) => read(`${packageDir(c.project)}/result.py`));
    expect(new Set(files).size).toBe(1);
    for (const key of [...Object.keys(CrewResult.shape).filter((k) => !k.startsWith("metrics") && k !== "usage"), "kind", "channel", "body_md", "due_in_days"]) {
      expect(files[0]).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it("receive exactly the inputs their task templates use", async () => {
    for (const crew of CREWS) {
      const built = await crew.buildInputs(io);
      expect("inputs" in built, crew.id).toBe(true);
      const keys = Object.keys((built as { inputs: Record<string, string> }).inputs).concat("goal").sort();
      const example = Object.keys(JSON.parse(read(`${crew.project}/inputs.example.json`))).sort();
      expect(keys, `${crew.id}: buildInputs vs inputs.example.json`).toEqual(example);
      const templates = read(`${packageDir(crew.project)}/config/tasks.yaml`) + read(`${packageDir(crew.project)}/config/agents.yaml`);
      const placeholders = [...new Set([...templates.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
      expect(placeholders, `${crew.id}: YAML placeholders`).toEqual(example);
      const yamlTasks = [...read(`${packageDir(crew.project)}/config/tasks.yaml`).matchAll(/^([a-z_]+):$/gm)].map((m) => m[1]);
      expect(yamlTasks, `${crew.id}: task ids`).toEqual(crew.tasks.map((t) => t.id));
    }
  });

  it("skip the run when there is nothing to work on", async () => {
    const empty: CrewIO = {
      ...io,
      async call<T>(tool: string): Promise<T> {
        if (tool === "github.list_commits") return { repo: "r", since: "", truncated: false, commits: [] } as T;
        if (tool === "division.get") return { id: "x", name: "X", status: "live", summary: null, metrics: {}, context_md: null } as T;
        if (tool === "events.recent") return { events: [] } as T;
        return io.call<T>(tool, {});
      },
    };
    const devlog = CREWS.find((c) => c.id === "averageoutput.devlog-crew")!;
    const review = CREWS.find((c) => c.id === "parlaylab.review-crew")!;
    expect(await devlog.buildInputs(empty)).toMatchObject({ skip: expect.stringContaining("No commits") });
    expect(await review.buildInputs(empty)).toMatchObject({ skip: expect.stringContaining("nothing to review") });
  });
});
