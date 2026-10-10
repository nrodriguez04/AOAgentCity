import { defineCrew, readInstructions } from "../../src/define";
import { contentCrewSpec } from "./spec";

export default defineCrew({
  ...contentCrewSpec,
  division: "creatoros",
  displayName: "CONTENT CREW",
  role: "Weekly content plan and posts: strategist, writer, editor",
  schedule: "0 8 * * 1", // Mondays 8am America/Chicago
  defaultGoal:
    "Plan this week's CreatorOS content from the strategy doc and what happened across the divisions, and draft every post for Nico to review.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "division.get", // read
    "events.recent", // read
    "drafts.recent", // read
    "draft.save", // internal_write
    "task.create", // internal_write
    "metric.record", // internal_write
  ],
  dailyBudgetUsd: 2,
});
