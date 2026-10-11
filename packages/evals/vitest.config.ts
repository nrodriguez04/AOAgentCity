import { defineConfig } from "vitest/config";

// Offline evals run each scenario through the real runtime on PGlite with a
// scripted model: no API key, no cost. Building the seeded database takes a few seconds.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
