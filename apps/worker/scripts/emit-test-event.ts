// Phase 1 check (spec §12): emit a test event and show the agent check-in.
//   DATABASE_URL=... pnpm emit:test [agentId]
import { emit, Repo, sqlFromEnv } from "@agent-city/db";

const agentId = process.argv[2] ?? "parlaylab.billing-01";
const sql = sqlFromEnv();
const repo = new Repo(sql);

const agent = await repo.getAgent(agentId);
if (!agent) {
  console.error(`No agent ${agentId}. Apply supabase/seed.sql or run \`pnpm agents:sync\` first.`);
  process.exit(1);
}
const event = await emit(repo, {
  division_id: agent.division_id,
  agent_id: agent.id,
  type: "run.progress",
  level: "info",
  summary: `Test event from emit-test-event at ${new Date().toISOString()}`,
  payload: { source: "scripts/emit-test-event.ts" },
});
const after = await repo.getAgent(agentId);
console.log("event", event);
console.log("agent", { id: after?.id, state: after?.state, last_checkin_at: after?.last_checkin_at });
await sql.close();
