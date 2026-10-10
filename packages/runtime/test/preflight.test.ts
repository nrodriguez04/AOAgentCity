import { createTestDatabase, type TestDatabase } from "@agent-city/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPreflight, preflight, type PreflightCheck } from "../src";

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase({ seed: true });
});
afterEach(async () => {
  await t.close();
});

const byName = (checks: PreflightCheck[], name: string) => checks.find((c) => c.name === name);

describe("preflight", () => {
  it("lists exactly what a fresh project is missing, without revealing any secret", async () => {
    const checks = await preflight({ repo: t.repo, env: {} });

    expect(byName(checks, "ANTHROPIC_API_KEY")).toMatchObject({ ok: false, required: true });
    expect(byName(checks, "DATABASE_URL")).toMatchObject({ ok: true });
    expect(byName(checks, "Owner account")).toMatchObject({ ok: false, required: true });

    // Only enabled agents are checked: the parked ParlayLab agents are not.
    expect(byName(checks, "Enabled agents")?.detail).toBe("3 enabled: DEVLOG CREW, CONTENT CREW, HQ-01");
    expect(checks.some((c) => c.name.startsWith("BILLING-01"))).toBe(false);

    // Each crew needs its CrewAI connection; the devlog crew also needs its GitHub token.
    expect(byName(checks, "DEVLOG CREW: crewai")).toMatchObject({
      ok: false,
      fix: `In Supabase's SQL editor: select vault.create_secret('{"url":"https://<deployment>.crewai.com","token":"..."}', 'agent:averageoutput.devlog-crew:crewai');`,
    });
    expect(byName(checks, "DEVLOG CREW: github")).toMatchObject({ ok: false });
    expect(byName(checks, "CONTENT CREW: crewai")).toMatchObject({ ok: false });
    expect(byName(checks, "Owner alerts")).toMatchObject({ ok: false, required: false });
    expect(byName(checks, "Instant approval execution")).toMatchObject({ ok: false });

    const report = formatPreflight(checks);
    expect(report).toContain("FAIL  ANTHROPIC_API_KEY");
    expect(report).toContain("todo  DEVLOG CREW: github");
    expect(report).toMatch(/2 required item\(s\) missing, \d+ to do\./);
  });

  it("passes once the worker, owner and credentials are in place", async () => {
    await t.sql.query(`insert into owners (user_id, note) values ('11111111-1111-4111-8111-111111111111', 'nico')`);
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ALERTS_RESEND_API_KEY: "re_test",
      ALERTS_EMAIL_TO: "owner@example.com",
      ALERTS_EMAIL_FROM: "Agent City <alerts@example.com>",
      CITY_URL: "https://city.example.com",
      // Local-development fallback for the Vault secrets (AGENT_SECRET__<AGENT>__<INTEGRATION>).
      AGENT_SECRET__AVERAGEOUTPUT_DEVLOG_CREW__CREWAI: '{"url":"https://devlog.crewai.com","token":"t"}',
      AGENT_SECRET__AVERAGEOUTPUT_DEVLOG_CREW__GITHUB: "github_pat_test",
      AGENT_SECRET__CREATOROS_CONTENT_CREW__CREWAI: '{"url":"https://content.crewai.com","token":"t"}',
    };
    const saved = { ...process.env };
    Object.assign(process.env, env); // resolveSecret's env fallback reads process.env
    try {
      const checks = await preflight({ repo: t.repo, env });
      const failing = checks.filter((c) => !c.ok).map((c) => c.name);
      expect(failing).toEqual(["Instant approval execution"]);
      expect(byName(checks, "Owner alerts")?.detail).toBe("on, to o***@example.com");
      expect(JSON.stringify(checks)).not.toContain("github_pat_test");
      expect(JSON.stringify(checks)).not.toContain("sk-ant-test");
      expect(formatPreflight(checks)).toContain("Ready to run. 1 item(s) still to do.");
    } finally {
      process.env = saved;
    }
  });
});

describe("preflight in the deploy workflow", () => {
  it("skips the worker's own variables, which live in Trigger.dev", async () => {
    const checks = await preflight({ repo: t.repo, env: {}, workerEnv: false });
    expect(checks.some((c) => c.area === "worker" || c.area === "alerts")).toBe(false);
    expect(byName(checks, "Owner account")).toMatchObject({ ok: false, required: true });
  });
});
