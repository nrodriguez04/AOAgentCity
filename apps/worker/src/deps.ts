import { Repo, sqlFromEnv } from "@agent-city/db";
import { ampCrewClient, anthropicModelClient, type CrewRuntimeDeps } from "@agent-city/runtime";
import { tasks, wait } from "@trigger.dev/sdk";
import type { divisionRun } from "./tasks/division-run";

let deps: CrewRuntimeDeps | undefined;

/** Shared per-process dependencies: one pooled DB client, one Claude client, one CrewAI AMP client. */
export function runtimeDeps(): CrewRuntimeDeps {
  deps ??= {
    repo: new Repo(sqlFromEnv()),
    model: anthropicModelClient(),
    crewClient: ampCrewClient(),
    // Between crew status checks: a checkpointed wait, so a long crew does not hold a machine.
    sleep: (ms) => wait.for({ seconds: Math.max(1, Math.round(ms / 1000)) }),
    services: {
      // HQ's hq.dispatch_run: queue a division run on that agent's own queue.
      dispatchRun: async ({ agentId, goal, parentRunId }) => {
        const handle = await tasks.trigger<typeof divisionRun>(
          "division-run",
          { agentId, goal, trigger: "hq", parentRunId },
          { concurrencyKey: agentId, tags: [`agent:${agentId}`, "trigger:hq"] },
        );
        return { id: handle.id };
      },
    },
  };
  return deps;
}
