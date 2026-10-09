import { CITY_TIMEZONE } from "@agent-city/core";
import { schedules, tasks } from "@trigger.dev/sdk";
import type { divisionRun } from "./division-run";

export const HQ_AGENT_ID = "hq.hq-01";

/** HQ-01's daily brief: 6:55 AM America/Chicago so it is ready by 7:00 (spec §8). */
export const hqDailyBrief = schedules.task({
  id: "hq-daily-brief",
  cron: { pattern: "55 6 * * *", timezone: CITY_TIMEZONE },
  run: async () => {
    const handle = await tasks.trigger<typeof divisionRun>(
      "division-run",
      { agentId: HQ_AGENT_ID, trigger: "cron" },
      { concurrencyKey: HQ_AGENT_ID, tags: [`agent:${HQ_AGENT_ID}`, "trigger:cron"] },
    );
    return { queued: handle.id };
  },
});
