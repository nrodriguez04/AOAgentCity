import { sweep } from "@agent-city/runtime";
import { logger, schedules } from "@trigger.dev/sdk";
import { runtimeDeps } from "../deps";

/**
 * Every 5 minutes: expire 72-hour-old approvals, execute approved actions the
 * database webhook did not deliver, and fail runs whose worker died.
 */
export const sweepApprovals = schedules.task({
  id: "sweep-approvals",
  cron: "*/5 * * * *",
  maxDuration: 120,
  run: async () => {
    const { repo, services } = runtimeDeps();
    const report = await sweep({ repo, services });
    if (report.expired || report.staleRunsFailed || Object.keys(report.executed).length) logger.info("sweep", { ...report });
    return report;
  },
});
