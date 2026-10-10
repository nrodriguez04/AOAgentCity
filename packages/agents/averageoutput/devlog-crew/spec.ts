import type { CrewSpec } from "@agent-city/core";
import { bullets, clip, day, weekLabel, type CommitsResult, type DivisionResult, type DraftsResult } from "../../src/crew-inputs";

/** The OTHERLIFE (codename AOWorld) game repository the devlog is written from. */
export const AOWORLD_REPO = "nrodriguez04/AOWorld";

const COMMIT_BODY_CHARS = 500;
const COMMITS_CHARS = 45_000;

// What the crew runner needs (no file reads, so the Trigger.dev bundle can load it).
export const devlogCrewSpec = {
  id: "averageoutput.devlog-crew",
  project: "crews/devlog",
  tasks: [
    { id: "analyze_changes", member: "Analyst", label: "Sorting the week's commits into player-facing changes" },
    { id: "write_devlog", member: "Writer", label: "Writing the devlog and social posts" },
    { id: "edit_and_package", member: "Editor", label: "Fact-checking every claim against the commits" },
  ],
  async buildInputs(io) {
    const { commits, truncated } = await io.call<CommitsResult>("github.list_commits", { repo: AOWORLD_REPO, days: 7, limit: 300 });
    const work = commits.filter((c) => !c.merge);
    if (work.length === 0) return { skip: `No commits to ${AOWORLD_REPO} in the last 7 days, so there is nothing for a devlog.` };

    const studio = await io.call<DivisionResult>("division.get", { division_id: "averageoutput" });
    const { drafts } = await io.call<DraftsResult>("drafts.recent", { division_id: "averageoutput", days: 90, limit: 30 });
    const devlogs = drafts.filter((d) => d.kind === "devlog");

    const commitText = work
      .map((c) => {
        const [subject = "", ...body] = c.message.trim().split("\n");
        const detail = body.join("\n").trim();
        return `[${day(c.date)}] ${c.sha} ${subject.trim()}${detail ? `\n  ${clip(detail, COMMIT_BODY_CHARS).replaceAll("\n", "\n  ")}` : ""}`;
      })
      .join("\n");

    return {
      inputs: {
        week_label: weekLabel(io.now()),
        repo: AOWORLD_REPO,
        commit_count: String(work.length) + (truncated ? " (only the newest are listed)" : ""),
        commits: clip(commitText, COMMITS_CHARS),
        studio_context: studio.context_md ?? "Average Output Studios builds OTHERLIFE, a persistent multiplayer life simulation.",
        previous_devlogs: bullets(devlogs.map((d) => `${day(d.created_at)}: ${d.title}`), "(no devlogs yet: this is the first one)"),
      },
    };
  },
} satisfies CrewSpec & { id: string };
