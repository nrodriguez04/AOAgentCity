import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoDecide, demoReviewDraft, demoSetPaused, startDemo } from "@/lib/demo";
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
  it("seeds the whole city with the four agents, three crews and two waiting approvals", () => {
    expect(state().connection).toBe("demo");
    expect(state().divisions).toHaveLength(9);
    expect(state().agents.map((a) => a.display_name)).toEqual(["HQ-01", "BILLING-01", "SUPPORT-01", "GROWTH-01", "DEVLOG CREW", "CONTENT CREW", "REVIEW CREW"]);
    expect(state().agents.filter((a) => a.runtime === "crewai").map((a) => a.division_id)).toEqual(["averageoutput", "creatoros", "parlaylab"]);
    expect(state().drafts.length).toBeGreaterThan(0);
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

  it("runs a crew member by member and hands back drafts and tasks", () => {
    vi.advanceTimersByTime(8_000);
    const before = state().drafts.length;
    vi.advanceTimersByTime(30_000);
    const crewEvents = state().events.filter((e) => e.agent_id === "averageoutput.devlog-crew").map((e) => e.summary);
    expect(crewEvents).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Analyst: .* \(1\/3\)$/),
      expect.stringMatching(/^Writer: .* \(2\/3\)$/),
      expect.stringMatching(/^Editor: .* \(3\/3\)$/),
      expect.stringMatching(/^Draft ready: OTHERLIFE devlog 2/),
      "New task: Review and publish devlog 2",
    ]));
    expect(state().drafts.length).toBeGreaterThan(before);
    expect(state().drafts[0]).toMatchObject({ agent_id: "averageoutput.devlog-crew", status: "draft" });
    const tower = deriveVisualState({ ...state(), acks: {}, selectedDivisionId: null }).find((b) => b.divisionId === "averageoutput")!;
    expect(tower.underConstruction).toBe(false);
  });

  it("reviews drafts like the database does: edits keep the agent's original text", () => {
    const draft = state().drafts[0]!;
    const original = draft.body_md;
    expect(demoReviewDraft(draft.id, { body_md: "Rewritten by Nico." })).toEqual({ ok: true });
    expect(demoReviewDraft(draft.id, { body_md: "Rewritten twice." })).toEqual({ ok: true });
    expect(demoReviewDraft(draft.id, { status: "approved" })).toEqual({ ok: true });
    expect(state().drafts.find((d) => d.id === draft.id)).toMatchObject({ status: "approved", body_md: "Rewritten twice.", original_body_md: original });

    expect(demoReviewDraft(draft.id, { status: "published", published_url: "https://x.com/nico/status/1" })).toEqual({ ok: true });
    expect(state().drafts.find((d) => d.id === draft.id)).toMatchObject({ status: "published", published_url: "https://x.com/nico/status/1" });
    expect(demoReviewDraft("missing", { status: "approved" })).toEqual({ ok: false, error: "This draft no longer exists." });
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
