import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Your Trigger.dev project ref, e.g. "proj_abc123" (Project settings in the dashboard).
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  runtime: "node",
  logLevel: "info",
  // Spec §6.2: 10 minute timeout per run.
  maxDuration: 600,
  dirs: ["./src/tasks"],
  retries: {
    enabledInDev: false,
    // Agent runs are not retried as a whole: the Claude SDK already retries
    // transient API errors per call, and re-running a whole run would repeat its
    // tool calls. Failures are recorded on the run and shown in the city.
    default: { maxAttempts: 1 },
  },
});
