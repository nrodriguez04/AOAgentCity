import { defineAgent, readInstructions } from "../../src/define";

export default defineAgent({
  id: "parlaylab.growth-01",
  division: "parlaylab",
  displayName: "GROWTH-01",
  role: "Signups, conversions and MRR",
  modelTier: "standard",
  schedule: "15 9 * * *", // daily 9:15am America/Chicago; experiments on Mondays
  defaultGoal:
    "Pull ParlayLab's subscription metrics from Stripe, record MRR, active subscriptions by tier, new subscriptions and cancellations, and keep 1-2 evidence-based growth experiments in the task backlog.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "stripe.get_metrics", // read
    "stripe.list_subscriptions", // read
    "metric.record", // internal_write
    "task.list", // read
    "task.create", // internal_write
  ],
  dailyBudgetUsd: 1,
  // Parked 2026-10-10: ParlayLab has no live billing, customers or support inbox yet.
  // Re-enable (and run `pnpm gen:seed` + `pnpm agents:sync`) once billing is live.
  enabled: false,
});
