import { alertConfigFromEnv, sendOwnerAlerts } from "@agent-city/runtime";
import { logger, schedules } from "@trigger.dev/sdk";
import { runtimeDeps } from "../deps";

/**
 * Every 5 minutes: email Nico newly pending approvals, failed runs and HQ's
 * brief (packages/runtime/src/alerts.ts). Needs ALERTS_RESEND_API_KEY,
 * ALERTS_EMAIL_TO and ALERTS_EMAIL_FROM (or EMAIL_FROM); without them it does
 * nothing and claims nothing.
 */
export const ownerAlerts = schedules.task({
  id: "owner-alerts",
  cron: "*/5 * * * *",
  maxDuration: 120,
  run: async () => {
    const { repo } = runtimeDeps();
    const outcome = await sendOwnerAlerts({ repo, config: alertConfigFromEnv() });
    if (outcome.status === "not_configured") {
      logger.info("owner alerts are off", { missing: outcome.missing });
      return outcome;
    }
    if (outcome.status === "done") {
      logger.info("owner alerts", { results: outcome.results.map(({ kind, items, status }) => ({ kind, items, status })) });
      const failed = outcome.results.filter((r) => r.status === "failed");
      // Mark this run failed in the Trigger.dev dashboard. The items were put back and go out on the next run.
      if (failed.length) throw new Error(`alert email failed: ${failed.map((f) => f.error).join("; ")}`);
    }
    return outcome;
  },
});
