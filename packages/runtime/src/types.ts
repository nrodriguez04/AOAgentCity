import type { Repo } from "@agent-city/db";
import type { ToolServices } from "@agent-city/tools";
import type { ModelClient } from "./model";

export interface RuntimeDeps {
  repo: Repo;
  model: ModelClient;
  /** Worker-provided capabilities (HQ dispatch); `complete` is supplied by the runtime. */
  services?: Pick<ToolServices, "dispatchRun" | "fetch">;
  now?: () => Date;
  maxSteps?: number;
  timeoutMs?: number;
}
