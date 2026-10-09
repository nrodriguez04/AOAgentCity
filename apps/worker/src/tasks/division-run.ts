import { RUN_TRIGGERS, type RunTrigger } from "@agent-city/core";
import { runAgent } from "@agent-city/runtime";
import { AbortTaskRunError, logger, schedules, task, tasks } from "@trigger.dev/sdk";
import { runtimeDeps } from "../deps";

export interface DivisionRunPayload {
  agentId: string;
  goal?: string | null;
  trigger: RunTrigger;
}

/**
 * Generic agent run (spec §8). One active run per agent: always trigger it with
 * `concurrencyKey: agentId`, which gives each agent its own queue with a
 * concurrency limit of 1.
 */
export const divisionRun = task({
  id: "division-run",
  queue: { name: "agent-runs", concurrencyLimit: 1 },
  maxDuration: 600,
  run: async (payload: DivisionRunPayload) => {
    if (!RUN_TRIGGERS.includes(payload.trigger)) throw new AbortTaskRunError(`bad trigger ${payload.trigger}`);
    const outcome = await runAgent(runtimeDeps(), payload);
    logger.info("agent run finished", { agentId: payload.agentId, ...outcome });
    if (outcome.status === "failed") {
      // Already recorded on the run and shown in the city. Fail the task too so the
      // Trigger.dev dashboard flags it; retries are off (see trigger.config.ts).
      throw new AbortTaskRunError(`${payload.agentId}: ${outcome.summary}`);
    }
    return outcome;
  },
});

/**
 * Target of the per-agent schedules that `pnpm agents:sync` creates from
 * agents.schedule_cron (externalId = agent id, timezone America/Chicago). It
 * only enqueues the real run on that agent's queue.
 */
export const agentScheduledRun = schedules.task({
  id: "agent-scheduled-run",
  run: async (payload) => {
    const agentId = payload.externalId;
    if (!agentId) throw new AbortTaskRunError("schedule has no externalId (agent id)");
    const handle = await tasks.trigger<typeof divisionRun>(
      "division-run",
      { agentId, trigger: "cron" },
      { concurrencyKey: agentId, tags: [`agent:${agentId}`, "trigger:cron"] },
    );
    return { queued: handle.id };
  },
});
