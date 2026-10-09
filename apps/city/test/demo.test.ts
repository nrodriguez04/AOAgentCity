import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoDecide, demoSetPaused, startDemo } from "@/lib/demo";
import { useCity } from "@/lib/store";
import { deriveVisualState } from "@/lib/visual-state";

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  stop = startDemo();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

const state = () => useCity.getState();

describe("demo mode", () => {
  it("seeds the whole city with the four agents and two waiting approvals", () => {
    expect(state().connection).toBe("demo");
    expect(state().divisions).toHaveLength(9);
    expect(state().agents.map((a) => a.display_name)).toEqual(["HQ-01", "BILLING-01", "SUPPORT-01", "GROWTH-01"]);
    expect(state().approvals.filter((a) => a.status === "pending")).toHaveLength(2);
    expect(state().brief?.body_md).toContain("# Daily brief");

    const buildings = deriveVisualState({ ...state(), acks: {}, selectedDivisionId: null });
    const parlaylab = buildings.find((b) => b.divisionId === "parlaylab")!;
    expect(parlaylab.beacon).toEqual({ active: true, count: 2 });
    expect(parlaylab.crown).toBe("error"); // SUPPORT-01's failed run, until acknowledged
    expect(parlaylab.display[0]).toMatchObject({ label: "MRR", value: "$4,210" });
    expect(buildings.find((b) => b.divisionId === "hq")!.searchlightUntil).not.toBeNull();
  });

  it("executes an approved action once, after a short delay", () => {
    const refund = state().approvals.find((a) => a.tier === "financial")!;
    expect(demoDecide(refund.id, "approved", "ok")).toEqual({ ok: true });
    expect(state().approvals.find((a) => a.id === refund.id)?.status).toBe("approved");
    expect(state().events[0]).toMatchObject({ type: "approval.decided", summary: `Approved: ${refund.title}` });

    vi.advanceTimersByTime(2_500);
    const done = state().approvals.find((a) => a.id === refund.id)!;
    expect(done.status).toBe("executed");
    expect(state().events.some((e) => e.type === "action.executed" && e.summary === `Done: ${refund.title}`)).toBe(true);
    expect(demoDecide(refund.id, "approved", null)).toMatchObject({ ok: false });
  });

  it("records rejections without executing anything", () => {
    const email = state().approvals.find((a) => a.tier === "external_effect")!;
    demoDecide(email.id, "rejected", "Too early to chase");
    vi.advanceTimersByTime(5_000);
    expect(state().approvals.find((a) => a.id === email.id)).toMatchObject({ status: "rejected", decided_note: "Too early to chase" });
    expect(state().events.some((e) => e.type === "action.executed" && e.summary.includes(email.title))).toBe(false);
  });

  it("keeps agents busy until paused", () => {
    vi.advanceTimersByTime(60_000);
    expect(state().events.some((e) => e.type === "run.started" && e.ts > new Date(Date.now() - 60_000).toISOString())).toBe(true);
    demoSetPaused(true);
    const before = state().events.length;
    vi.advanceTimersByTime(60_000);
    const started = state().events.slice(0, state().events.length - before).filter((e) => e.type === "run.started");
    expect(started).toHaveLength(0);
    expect(state().agents.every((a) => a.state !== "working")).toBe(true);
  });
});
