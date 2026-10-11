import { describe, expect, it } from "vitest";
import {
  APP_IDS,
  isAppEventType,
  isOpenAppApproval,
  parseCrewOutput,
  AgentEvent,
  computeCostUsd,
  DEFAULT_MODEL_PRICING,
  DIVISIONS,
  BUILDING_MODELS,
  requiresApproval,
  startOfDayInZone,
  tierAllows,
  toSummary,
  formatMinorUnits,
} from "../src";

const pricing = (model: string) => DEFAULT_MODEL_PRICING.find((p) => p.model === model)!;

describe("event contract", () => {
  it("applies defaults for level and payload", () => {
    const event = AgentEvent.parse({ division_id: "parlaylab", type: "run.started", summary: "Check failed payments" });
    expect(event.level).toBe("info");
    expect(event.payload).toEqual({});
  });

  it("rejects unknown types, long summaries and malformed run ids", () => {
    expect(AgentEvent.safeParse({ division_id: "hq", type: "run.exploded", summary: "x" }).success).toBe(false);
    expect(AgentEvent.safeParse({ division_id: "hq", type: "run.started", summary: "x".repeat(201) }).success).toBe(false);
    expect(AgentEvent.safeParse({ division_id: "hq", type: "run.started", summary: "x", run_id: "not-a-uuid" }).success).toBe(false);
  });

  it("clamps free text to a one-line summary", () => {
    const summary = toSummary(`line one\n\nline two ${"y".repeat(300)}`);
    expect(summary.length).toBe(200);
    expect(summary).not.toContain("\n");
    expect(toSummary("   ")).toBe("(no summary)");
  });
});

describe("risk tiers", () => {
  it("requires approval only for external and financial effects", () => {
    expect(requiresApproval("read")).toBe(false);
    expect(requiresApproval("internal_write")).toBe(false);
    expect(requiresApproval("external_effect")).toBe(true);
    expect(requiresApproval("financial")).toBe(true);
  });

  it("orders tiers for permission checks", () => {
    expect(tierAllows("financial", "read")).toBe(true);
    expect(tierAllows("internal_write", "external_effect")).toBe(false);
    expect(tierAllows("external_effect", "financial")).toBe(false);
  });
});

describe("cost accounting", () => {
  it("prices plain input and output tokens", () => {
    const cost = computeCostUsd(pricing("claude-sonnet-5-5"), { input_tokens: 1_000_000, output_tokens: 100_000 });
    expect(cost).toBeCloseTo(2 + 1, 6);
  });

  it("prices cache reads and both cache write durations", () => {
    const cost = computeCostUsd(pricing("claude-opus-5-5"), {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    });
    expect(cost).toBeCloseTo(0.2 + 5 + 8, 6);
  });

  it("switches Haiku to long-context rates above 100K prompt tokens", () => {
    const short = computeCostUsd(pricing("claude-haiku-5-5"), { input_tokens: 100_000, output_tokens: 1_000_000 });
    const long = computeCostUsd(pricing("claude-haiku-5-5"), { input_tokens: 100_001, output_tokens: 1_000_000 });
    expect(short).toBeCloseTo(0.01 + 0.5, 6);
    expect(long).toBeCloseTo(100_001 * 0.5e-6 + 2.5, 6);
  });
});

describe("divisions", () => {
  it("accepts app events only in a connected app's namespace, like the database", () => {
    for (const ok of ["fedops.opportunity.qualified", "halo.lead.stage.changed", "galleyswap.trip.posted"]) expect(isAppEventType(ok)).toBe(true);
    for (const bad of ["run.succeeded", "fedops.one", "fedops.Opportunity.qualified", "evil.thing.happened", "fedops.a.b.c.d", "fedops..x"]) {
      expect(isAppEventType(bad)).toBe(false);
    }
    // Every app is also a division, so its events and approvals have a tower to land on.
    for (const app of APP_IDS) expect(DIVISIONS.some((d) => d.id === app)).toBe(true);
  });

  it("treats an app approval as open while pending and unexpired", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(isOpenAppApproval({ status: "pending", expires_at: null }, now)).toBe(true);
    expect(isOpenAppApproval({ status: "pending", expires_at: "2026-10-11T13:00:00Z" }, now)).toBe(true);
    expect(isOpenAppApproval({ status: "pending", expires_at: "2026-10-11T11:00:00Z" }, now)).toBe(false);
    expect(isOpenAppApproval({ status: "approved", expires_at: null }, now)).toBe(false);
  });

  it("defines all nine divisions with unique ids and known building models", () => {
    expect(DIVISIONS).toHaveLength(9);
    expect(new Set(DIVISIONS.map((d) => d.id)).size).toBe(9);
    for (const d of DIVISIONS) expect(BUILDING_MODELS).toContain(d.slot.buildingModel);
  });
});

describe("time", () => {
  it("finds Chicago midnight across daylight saving changes", () => {
    // 2026-11-01 is the US fall-back day; 10:00 UTC is 04:00 CST.
    expect(startOfDayInZone(new Date("2026-11-01T10:00:00Z")).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    // A summer day: midnight CDT is 05:00 UTC.
    expect(startOfDayInZone(new Date("2026-07-04T23:30:00Z")).toISOString()).toBe("2026-07-04T05:00:00.000Z");
    // Winter day: midnight CST is 06:00 UTC; 03:00 UTC still belongs to the previous local day.
    expect(startOfDayInZone(new Date("2026-01-15T03:00:00Z")).toISOString()).toBe("2026-01-14T06:00:00.000Z");
  });
});

describe("money", () => {
  it("formats Stripe minor units", () => {
    expect(formatMinorUnits(1900, "usd")).toBe("$19.00");
    expect(formatMinorUnits(500, "jpy")).toBe("¥500");
  });
});

describe("crew results", () => {
  const result = { summary: "Devlog 2 drafted", drafts: [{ kind: "devlog", channel: "blog", title: "Devlog 2", body_md: "# Devlog 2" }], tasks: [] };

  it("finds the JSON in plain, fenced or wrapped output", () => {
    for (const text of [JSON.stringify(result), "```json\n" + JSON.stringify(result) + "\n```", `Here you go:\n${JSON.stringify(result)}\nDone.`]) {
      const parsed = parseCrewOutput(text);
      expect(parsed).toMatchObject({ ok: true, result: { summary: "Devlog 2 drafted", tasks: [] } });
    }
  });

  it("rejects results outside the contract", () => {
    expect(parseCrewOutput("no json here")).toEqual({ ok: false, error: "the output contains no JSON object" });
    const bad = parseCrewOutput(JSON.stringify({ ...result, drafts: [{ kind: "tweetstorm", title: "x", body_md: "y" }] }));
    expect(bad.ok).toBe(false);
    expect(parseCrewOutput(JSON.stringify({ ...result, tasks: Array(6).fill({ title: "Do the thing" }) })).ok).toBe(false);
  });
});
