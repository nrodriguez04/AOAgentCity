// Run one agent locally, outside Trigger.dev (spec §12 phase 2: "triggered manually").
//   DATABASE_URL=... ANTHROPIC_API_KEY=... pnpm agent:run parlaylab.billing-01 ["optional goal"]
// HQ dispatches are sent to Trigger.dev when TRIGGER_SECRET_KEY is set.
import { Repo, sqlFromEnv } from "@agent-city/db";
import { anthropicModelClient, runAgent } from "@agent-city/runtime";
import { tasks } from "@trigger.dev/sdk";

const [agentId, ...goalWords] = process.argv.slice(2);
if (!agentId) {
  console.error("usage: pnpm agent:run <agentId> [goal]");
  process.exit(1);
}
const sql = sqlFromEnv();
const outcome = await runAgent(
  {
    repo: new Repo(sql),
    model: anthropicModelClient(),
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
