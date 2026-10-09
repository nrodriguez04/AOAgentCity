import { Repo, sqlFromEnv } from "@agent-city/db";
import { anthropicModelClient, type RuntimeDeps } from "@agent-city/runtime";
import { tasks } from "@trigger.dev/sdk";
import type { divisionRun } from "./tasks/division-run";

let deps: RuntimeDeps | undefined;

/** Shared per-process dependencies: one pooled DB client, one Claude client. */
export function runtimeDeps(): RuntimeDeps {
  deps ??= {
    repo: new Repo(sqlFromEnv()),
    model: anthropicModelClient(),
    services: {
      // HQ's hq.dispatch_run: queue a division run on that agent's own queue.
      dispatchRun: async ({ agentId, goal }) => {
        const handle = await tasks.trigger<typeof divisionRun>(
          "division-run",
          { agentId, goal, trigger: "hq" },
          { concurrencyKey: agentId, tags: [`agent:${agentId}`, "trigger:hq"] },
        );
        return { id: handle.id };
      },
    },
  };
  return deps;
}
