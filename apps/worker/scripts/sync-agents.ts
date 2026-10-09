// Sync agent definitions from code into Supabase, then register each scheduled
// agent with Trigger.dev (spec §8: schedules from agents.schedule_cron,
// CRON_TZ=America/Chicago).
//   DATABASE_URL=... TRIGGER_SECRET_KEY=... pnpm agents:sync
import { AGENTS, CODE_SCHEDULED_AGENT_IDS, syncToDatabase } from "@agent-city/agents";
import { CITY_TIMEZONE } from "@agent-city/core";
import { Repo, sqlFromEnv } from "@agent-city/db";
import { schedules } from "@trigger.dev/sdk";

const sql = sqlFromEnv();
const repo = new Repo(sql);
const result = await syncToDatabase(repo);
console.log(`database: ${result.divisions} divisions, ${result.agents} agents, ${result.permissions} tool grants`);

if (!process.env.TRIGGER_SECRET_KEY) {
  console.log("TRIGGER_SECRET_KEY not set: skipped Trigger.dev schedules.");
} else {
  const existing = new Map<string, string>();
  for await (const s of schedules.list()) {
    if (s.task === "agent-scheduled-run" && s.externalId) existing.set(s.externalId, s.id);
  }
  for (const agent of AGENTS) {
    if (CODE_SCHEDULED_AGENT_IDS.has(agent.id)) continue;
    const scheduleId = existing.get(agent.id);
    if (agent.schedule && agent.enabled) {
      const schedule = await schedules.create({
        task: "agent-scheduled-run",
        cron: agent.schedule,
        timezone: CITY_TIMEZONE,
        externalId: agent.id,
        deduplicationKey: `agent:${agent.id}`,
      });
      console.log(`schedule ${agent.id}: ${agent.schedule} ${CITY_TIMEZONE} (${schedule.id})`);
    } else if (scheduleId) {
      await schedules.del(scheduleId);
      console.log(`schedule ${agent.id}: removed`);
    }
  }
}
await sql.close();
