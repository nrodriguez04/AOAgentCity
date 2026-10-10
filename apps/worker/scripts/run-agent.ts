// Run one agent or crew locally, outside Trigger.dev (spec §12 phase 2: "triggered manually").
//   DATABASE_URL=... ANTHROPIC_API_KEY=... pnpm agent:run parlaylab.billing-01 ["optional goal"]
//   DATABASE_URL=... pnpm agent:run averageoutput.devlog-crew   (needs the crew's CrewAI secret)
// HQ dispatches are sent to Trigger.dev when TRIGGER_SECRET_KEY is set.
import { Repo, sqlFromEnv } from "@agent-city/db";
import { ampCrewClient, anthropicModelClient } from "@agent-city/runtime";
import { tasks } from "@trigger.dev/sdk";
import { runDivisionAgent } from "../src/tasks/division-run";

const [agentId, ...goalWords] = process.argv.slice(2);
if (!agentId) {
  console.error("usage: pnpm agent:run <agentId> [goal]");
  process.exit(1);
}
const sql = sqlFromEnv();
const outcome = await runDivisionAgent(
  {
    repo: new Repo(sql),
    model: anthropicModelClient(),
    crewClient: ampCrewClient(),
    services: process.env.TRIGGER_SECRET_KEY
      ? {
          dispatchRun: async ({ agentId: target, goal }) => {
            const handle = await tasks.trigger("division-run", { agentId: target, goal, trigger: "hq" }, { concurrencyKey: target });
            return { id: handle.id };
          },
        }
      : {},
  },
  { agentId, goal: goalWords.join(" ") || null, trigger: "manual" },
);
console.log(JSON.stringify(outcome, null, 2));
await sql.close();
