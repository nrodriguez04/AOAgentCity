import type { CrewSpec } from "@agent-city/core";
import { bullets, clip, day, weekLabel, type DivisionResult, type DraftsResult, type EventsResult } from "../../src/crew-inputs";

const HIGHLIGHT_TYPES = new Set(["run.succeeded", "brief.published", "metric.updated", "task.created"]);
const MAX_HIGHLIGHTS = 60;

// What the crew runner needs (no file reads, so the Trigger.dev bundle can load it).
export const contentCrewSpec = {
  id: "creatoros.content-crew",
  project: "crews/content",
  tasks: [
    { id: "plan_week", member: "Strategist", label: "Choosing this week's posts" },
    { id: "write_posts", member: "Writer", label: "Writing each post for its platform" },
    { id: "edit_and_package", member: "Editor", label: "Editing for voice and accuracy" },
  ],
  async buildInputs(io) {
    const creator = await io.call<DivisionResult>("division.get", { division_id: "creatoros" });
    const { events } = await io.call<EventsResult>("events.recent", { hours: 168, limit: 200 });
    const { drafts } = await io.call<DraftsResult>("drafts.recent", { days: 21, limit: 60 });

    const highlights = events
      .filter((e) => e.division_id !== "creatoros" && (HIGHLIGHT_TYPES.has(e.type) || e.summary.startsWith("Draft ready:")))
      .slice(0, MAX_HIGHLIGHTS)
      .map((e) => `${day(e.ts)} [${e.division_id}] ${e.summary}`);
    const sources = drafts
      .filter((d) => d.division_id !== "creatoros" && d.kind !== "social_post")
      .slice(0, 10)
      .map((d) => `${day(d.created_at)} [${d.division_id}] ${d.kind}: ${d.title}\n  ${d.excerpt.replaceAll("\n", " ")}`);
    const ownPosts = drafts.filter((d) => d.division_id === "creatoros").map((d) => `${day(d.created_at)} ${d.channel ?? d.kind}: ${d.title}`);
    const metrics = Object.entries(creator.metrics).map(([k, m]) => `${m.label ?? k}: ${m.value}${m.unit === "percent" ? "%" : ""}`);

    return {
      inputs: {
        week_label: weekLabel(io.now()),
        strategy: creator.context_md ?? "(no strategy written yet)",
        metrics: bullets(metrics, "(no metrics recorded yet)"),
        highlights: clip(bullets(highlights, "(nothing recorded across the divisions this week)"), 12_000),
        source_drafts: clip(bullets(sources, "(no devlogs, reports or articles this period)"), 8_000),
        recent_posts: clip(bullets(ownPosts, "(no posts drafted yet)"), 4_000),
      },
    };
  },
} satisfies CrewSpec & { id: string };
