import { defineAgent, readInstructions } from "../../src/define";

export default defineAgent({
  id: "parlaylab.support-01",
  division: "parlaylab",
  displayName: "SUPPORT-01",
  role: "Support inbox triage and replies",
  modelTier: "standard", // drafting; classification inside support.classify uses the fast model
  schedule: "30 9,13,17 * * *", // 9:30am, 1:30pm, 5:30pm America/Chicago
  defaultGoal:
    "Triage ParlayLab's unread support email: classify and label every thread, draft and queue replies for approval, and route refund requests and bugs as tasks.",
  instructions: readInstructions(new URL("./instructions.md", import.meta.url)),
  tools: [
    "support.list_inbox", // read
    "support.get_thread", // read
    "support.classify", // read (fast model)
    "support.tag_thread", // internal_write (labels only)
    "stripe.find_customer", // read
    "email.draft", // internal_write
    "email.send", // external_effect -> approval
    "task.create", // internal_write
  ],
  dailyBudgetUsd: 2,
});
