import { defineAgent, readInstructions } from "../src/define";

export default defineAgent({
  id: "hq.hq-01",
  division: "hq",
  displayName: "HQ-01",
  role: "Daily brief and routing",
  modelTier: "reasoning",
  // 6:55 AM so the brief is ready by 7:00 (America/Chicago). Scheduled in code
  // by apps/worker/src/tasks/hq.ts rather than by agents:sync.
  schedule: "55 6 * * *",
  defaultGoal:
    "Write and publish today's daily brief for Nico: what moved, what needs him, what's stale, the top 3 priorities and yesterday's spend. Route work where there is a clear reason.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "divisions.list",
    "events.recent",
    "runs.recent",
    "approvals.list",
    "spend.summary",
    "task.list",
    "task.create",
    "task.update",
    "division.update_context",
    "hq.dispatch_run",
    "hq.flag_stale",
    "brief.publish",
  ],
  dailyBudgetUsd: 3,
});
