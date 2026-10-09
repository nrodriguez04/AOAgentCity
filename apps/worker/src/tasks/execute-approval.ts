import { executeApproval } from "@agent-city/runtime";
import { logger, task } from "@trigger.dev/sdk";
import { runtimeDeps } from "../deps";

/**
 * Executes an approved action verbatim (spec §7.3). Triggered by the database
 * when Nico approves (pg_net, idempotency key = approval id) and by the sweeper
 * as a backstop. Safe to run more than once: only one execution can claim it.
 */
export const executeApprovalTask = task({
  id: "execute-approval",
  queue: { name: "approvals", concurrencyLimit: 5 },
  maxDuration: 120,
  run: async (payload: { approvalId: string }) => {
    const { repo, services } = runtimeDeps();
    const outcome = await executeApproval({ repo, services }, payload.approvalId);
    logger.info("approval execution", { approvalId: payload.approvalId, outcome });
    return { outcome };
  },
});
