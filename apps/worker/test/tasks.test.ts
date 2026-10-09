import { describe, expect, it } from "vitest";
import { agentScheduledRun, divisionRun } from "../src/tasks/division-run";
import { executeApprovalTask } from "../src/tasks/execute-approval";
import { hqDailyBrief } from "../src/tasks/hq";
import { sweepApprovals } from "../src/tasks/sweep";

describe("worker tasks", () => {
  it("registers the tasks the database and HQ trigger by id", () => {
    // pg_net in 0003_approval_decisions.sql posts to /api/v1/tasks/execute-approval/trigger.
    expect(executeApprovalTask.id).toBe("execute-approval");
    // hq.dispatch_run and the schedules enqueue "division-run".
    expect(divisionRun.id).toBe("division-run");
    // agents:sync attaches per-agent schedules to this task.
    expect(agentScheduledRun.id).toBe("agent-scheduled-run");
    expect(hqDailyBrief.id).toBe("hq-daily-brief");
    expect(sweepApprovals.id).toBe("sweep-approvals");
  });
});
