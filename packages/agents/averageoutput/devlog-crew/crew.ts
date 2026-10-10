import { defineCrew, readInstructions } from "../../src/define";
import { devlogCrewSpec } from "./spec";

export default defineCrew({
  ...devlogCrewSpec,
  division: "averageoutput",
  displayName: "DEVLOG CREW",
  role: "Weekly OTHERLIFE devlog: analyst, writer, editor",
  schedule: "0 15 * * 5", // Fridays 3pm America/Chicago
  defaultGoal:
    "Turn this week's AOWorld commits into an OTHERLIFE devlog draft and two or three social posts for Nico to review.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "github.list_commits", // read, with a read-only token for AOWorld
    "division.get", // read
    "drafts.recent", // read
    "draft.save", // internal_write
    "task.create", // internal_write
    "metric.record", // internal_write
  ],
  dailyBudgetUsd: 2,
});
