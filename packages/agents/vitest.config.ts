import { defineConfig } from "vitest/config";

// These tests run the real migrations on PGlite (in-process Postgres), which can
// take several seconds on a busy machine.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
