import type { CrewSpec } from "@agent-city/core";
import { bullets, clip, day, weekLabel, type DivisionResult, type DraftsResult, type EventsResult, type TasksResult } from "../../src/crew-inputs";

// What the crew runner needs (no file reads, so the Trigger.dev bundle can load it).
export const reviewCrewSpec = {
  id: "parlaylab.review-crew",
  project: "crews/review",
  tasks: [
    { id: "analyze_week", member: "Analyst", label: "Measuring the week from ParlayLab's data" },
    { id: "write_review", member: "Strategist", label: "Writing the review and recommendations" },
  ],
  async buildInputs(io) {
    const parlaylab = await io.call<DivisionResult>("division.get", { division_id: "parlaylab" });
    const { events } = await io.call<EventsResult>("events.recent", { division_id: "parlaylab", hours: 168, limit: 200 });
    // Only what ParlayLab's agents did counts as data; this crew's own events do not.
    const activity = events.filter((e) => e.agent_id !== io.agent.id);
    const metrics = Object.entries(parlaylab.metrics);
    if (activity.length === 0 && metrics.length === 0) {
      return { skip: "ParlayLab has no metrics or agent activity in the last 7 days yet, so there is nothing to review." };
    }

    const { tasks } = await io.call<TasksResult>("task.list", { division_id: "parlaylab", limit: 50 });
    const { drafts } = await io.call<DraftsResult>("drafts.recent", { division_id: "parlaylab", days: 35, limit: 10 });
    const reviews = drafts.filter((d) => d.kind === "report");

    return {
      inputs: {
        week_label: weekLabel(io.now()),
        business_context: parlaylab.context_md ?? parlaylab.summary ?? "ParlayLab is a subscription product billed through Stripe.",
        metrics_now: bullets(
          metrics.map(([k, m]) => `${k} = ${m.value}${m.unit ? ` ${m.unit}` : ""}${m.delta !== undefined ? ` (change ${m.delta})` : ""}${m.as_of ? ` as of ${day(m.as_of)}` : ""}`),
          "(no metrics recorded yet)",
        ),
        activity: clip(bullets(activity.map((e) => `${e.ts.slice(0, 16).replace("T", " ")} ${e.type} ${e.agent_id ?? "system"}: ${e.summary}`)), 20_000),
        open_tasks: clip(bullets(tasks.map((t) => `P${t.priority} ${t.status} (${t.owner}): ${t.title}`)), 6_000),
        previous_reviews: clip(bullets(reviews.map((d) => `${day(d.created_at)}: ${d.title}\n  ${d.excerpt.replaceAll("\n", " ")}`), "(no earlier reviews)"), 4_000),
      },
    };
  },
} satisfies CrewSpec & { id: string };
