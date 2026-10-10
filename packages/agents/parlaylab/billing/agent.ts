import { defineAgent, readInstructions } from "../../src/define";

export default defineAgent({
  id: "parlaylab.billing-01",
  division: "parlaylab",
  displayName: "BILLING-01",
  role: "Subscription operations",
  modelTier: "standard",
  schedule: "0 8,17 * * *", // 8am and 5pm, America/Chicago
  defaultGoal:
    "Review ParlayLab's failed payments and past-due subscriptions. Draft and queue dunning emails for approval where needed, propose refunds only for clear billing errors, and record failed-payment metrics.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "stripe.list_subscriptions", // read
    "stripe.list_failed_payments", // read
    "stripe.find_customer", // read
    "email.draft", // internal_write
    "email.send", // external_effect -> approval
    "stripe.issue_refund", // financial -> always approval
    "metric.record", // internal_write
    "task.create", // internal_write
  ],
  dailyBudgetUsd: 1.5,
  // Parked 2026-10-10: ParlayLab has no live billing, customers or support inbox yet.
  // Re-enable (and run `pnpm gen:seed` + `pnpm agents:sync`) once billing is live.
  enabled: false,
});
