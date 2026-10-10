import { defineCrew, readInstructions } from "../../src/define";
import { reviewCrewSpec } from "./spec";

export default defineCrew({
  ...reviewCrewSpec,
  division: "parlaylab",
  displayName: "REVIEW CREW",
  role: "Weekly business review: analyst, strategist",
  schedule: "15 7 * * 1", // Mondays 7:15am America/Chicago, after HQ's brief
  defaultGoal:
    "Write ParlayLab's weekly business review from its metrics and agent activity, and turn the top recommendations into tasks.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "division.get", // read
    "events.recent", // read
    "task.list", // read
    "drafts.recent", // read
    "draft.save", // internal_write
    "task.create", // internal_write
    "metric.record", // internal_write
  ],
  dailyBudgetUsd: 2,
  // Parked 2026-10-10: ParlayLab has no live billing, customers or support inbox yet.
  // Re-enable (and run `pnpm gen:seed` + `pnpm agents:sync`) once billing is live.
  enabled: false,
});
