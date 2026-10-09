import { describe, expect, it } from "vitest";
import {
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
