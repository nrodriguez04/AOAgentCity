import { DIVISIONS, type AgentRow, type ApprovalRow, type DivisionRow, type EventRow } from "@agent-city/core";
import { describe, expect, it } from "vitest";
import { deriveAmbience, deriveVisualState, displayLines, type StoreSnapshot } from "@/lib/visual-state";

const NOW = Date.parse("2026-10-10T13:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const divisions: DivisionRow[] = DIVISIONS.map((d) => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  status: d.status,
  summary: d.summary,
  context_md: d.contextMd,
  city_slot: d.slot,
  metrics: {},
  created_at: iso(-86_400_000),
}));

function agent(id: string, division_id: string, state: AgentRow["state"] = "idle", extra: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    division_id,
    display_name: id.split(".")[1]!.toUpperCase(),
    role: "role",
    model_tier: "standard",
    instructions: "",
    default_goal: null,
    schedule_cron: null,
    state,
    last_checkin_at: iso(-60_000),
    daily_budget_usd: 2,
    enabled: true,
    created_at: iso(-86_400_000),
    ...extra,
  };
}

let eventId = 0;
function event(division_id: string, type: EventRow["type"], offsetMs: number, level: EventRow["level"] = "info"): EventRow {
  return { id: ++eventId, ts: iso(offsetMs), division_id, agent_id: null, run_id: null, type, level, summary: type, payload: {} };
}

function approval(division_id: string, extra: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: `ap-${Math.random()}`,
    created_at: iso(-600_000),
    division_id,
    agent_id: "parlaylab.billing-01",
    run_id: null,
    tier: "financial",
    title: "Refund",
    rationale: "r",
    action: { tool: "stripe.issue_refund", args: {} },
    action_hash: "h",
    amount_cents: 1900,
    currency: "usd",
    status: "pending",
    decided_at: null,
    decided_note: null,
    expires_at: iso(3_600_000),
    executed_at: null,
    result: null,
    ...extra,
  };
}

function snapshot(overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    divisions,
    agents: [
      agent("hq.hq-01", "hq"),
      agent("parlaylab.billing-01", "parlaylab"),
      agent("parlaylab.support-01", "parlaylab"),
      agent("parlaylab.growth-01", "parlaylab"),
    ],
    approvals: [],
    events: [],
    brief: null,
    settings: { agents_paused: false, trigger_api_url: "", updated_at: iso(0) },
    acks: {},
    selectedDivisionId: null,
    ...overrides,
  };
}

const building = (s: StoreSnapshot, id: string) => deriveVisualState(s, NOW).find((b) => b.divisionId === id)!;

describe("deriveVisualState", () => {
  it("returns one building per division in the division-bar order", () => {
    expect(deriveVisualState(snapshot(), NOW).map((b) => b.divisionId)).toEqual(DIVISIONS.map((d) => d.id));
  });

  it("dims idle towers to ambient light with a steady crown", () => {
    const b = building(snapshot(), "parlaylab");
    expect(b).toMatchObject({ floors: { bands: 3, activeBands: 0 }, ambientLit: 0.2, crown: "steady", underConstruction: false });
  });

  it("lights one floor band per working agent and pulses the crown", () => {
    const s = snapshot();
    s.agents = s.agents.map((a) => (a.id === "parlaylab.support-01" || a.id === "parlaylab.growth-01" ? { ...a, state: "working" } : a));
    expect(building(s, "parlaylab")).toMatchObject({ floors: { bands: 3, activeBands: 2 }, crown: "pulse" });
  });

  it("flashes the rooftop beacon with a badge count for pending, unexpired approvals", () => {
    const s = snapshot({
      approvals: [approval("parlaylab"), approval("parlaylab"), approval("parlaylab", { expires_at: iso(-1) }), approval("parlaylab", { status: "approved" })],
    });
    expect(building(s, "parlaylab").beacon).toEqual({ active: true, count: 2 });
    expect(building(s, "hq").beacon).toEqual({ active: false, count: 0 });
  });

  it("turns the crown red after a failure until it is acknowledged", () => {
    const failed = event("parlaylab", "run.failed", -120_000, "error");
    expect(building(snapshot({ events: [failed] }), "parlaylab").crown).toBe("error");
    expect(building(snapshot({ events: [failed], acks: { parlaylab: iso(-60_000) } }), "parlaylab").crown).toBe("steady");
  });

  it("starts the success flash only for a fresh run.succeeded", () => {
    expect(building(snapshot({ events: [event("parlaylab", "run.succeeded", -1_000)] }), "parlaylab").flashAt).toBe(NOW - 1_000);
    expect(building(snapshot({ events: [event("parlaylab", "run.succeeded", -60_000)] }), "parlaylab").flashAt).toBeNull();
  });

  it("puts the latest metrics on the LED band and billboards", () => {
    const s = snapshot();
    s.divisions = s.divisions.map((d) =>
      d.id === "parlaylab"
        ? { ...d, metrics: { active_subscriptions: { value: 182, unit: "count" }, mrr: { value: 4210, unit: "usd", delta: 3.1 } } }
        : d,
    );
    expect(building(s, "parlaylab").display).toEqual([
      { label: "MRR", value: "$4,210", tone: "up" },
      { label: "ACTIVE", value: "182", tone: "neutral" },
    ]);
  });

  it("shows planned and concept divisions under construction", () => {
    expect(building(snapshot(), "halo")).toMatchObject({ underConstruction: true, crown: "off" });
    expect(building(snapshot(), "creatoros").underConstruction).toBe(false);
  });

  it("sweeps the HQ searchlight after a brief is published", () => {
    const s = snapshot({ events: [event("hq", "brief.published", -5 * 60_000, "success")] });
    expect(building(s, "hq").searchlightUntil).toBe(NOW - 5 * 60_000 + 20 * 60_000);
    expect(building(snapshot({ events: [event("hq", "brief.published", -60 * 60_000)] }), "hq").searchlightUntil).toBeNull();
  });

  it("dims everything and stops sweeps when the city is paused", () => {
    const s = snapshot({ events: [event("hq", "brief.published", -60_000)] });
    s.settings = { ...s.settings!, agents_paused: true };
    s.agents = s.agents.map((a) => ({ ...a, state: "working" }));
    const hq = building(s, "hq");
    expect(hq).toMatchObject({ dimmed: true, ambientLit: 0.08, floors: { bands: 1, activeBands: 0 }, searchlightUntil: null });
  });

  it("marks the selected division", () => {
    expect(building(snapshot({ selectedDivisionId: "fedops" }), "fedops").selected).toBe(true);
  });
});

describe("deriveAmbience", () => {
  it("scales traffic with run volume over the last hour", () => {
    const quiet = deriveAmbience(snapshot(), false, NOW);
    const busy = deriveAmbience(snapshot({ events: Array.from({ length: 12 }, (_, i) => event("parlaylab", "run.started", -i * 60_000)) }), false, NOW);
    const old = deriveAmbience(snapshot({ events: [event("parlaylab", "run.started", -2 * 3_600_000)] }), false, NOW);
    expect(quiet.trafficDensity).toBeCloseTo(0.18);
    expect(busy.trafficDensity).toBe(1);
    expect(old.trafficDensity).toBeCloseTo(0.18);
    expect(deriveAmbience({ events: [], settings: { agents_paused: true, trigger_api_url: "", updated_at: "" } }, true, NOW)).toEqual({
      trafficDensity: 0.08,
      paused: true,
      lowGraphics: true,
    });
  });
});

describe("displayLines", () => {
  it("formats units and keeps known metrics first", () => {
    expect(
      displayLines({
        zebra: { value: 2, unit: "count" },
        engagement_rate: { value: 4.25, unit: "percent", delta: -0.5 },
        followers: { value: 12_400, unit: "count" },
      }),
    ).toEqual([
      { label: "FOLLOWERS", value: "12.4K", tone: "neutral" },
      { label: "ENGAGEMENT", value: "4.3%", tone: "down" },
      { label: "ZEBRA", value: "2", tone: "neutral" },
    ]);
  });
});
