"use client";

import { isOpenAppApproval } from "@agent-city/core";
import { useShallow } from "zustand/react/shallow";
import { useCity } from "@/lib/store";
import { AppApprovalCard } from "./AppApprovalCard";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalsView({ now }: { now: number }) {
  const approvals = useCity((s) => s.approvals);
  const pending = approvals
    .filter((a) => a.status === "pending" && new Date(a.expires_at).getTime() > now)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const recent = approvals
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))
    .slice(0, 8);
  const inApps = useCity(
    useShallow((s) => s.appApprovals.filter((a) => isOpenAppApproval(a, now)).sort((a, b) => a.requested_at.localeCompare(b.requested_at))),
  );

  return (
    <div className="stack">
      <p className="muted small">
        Spending money, contacting people and posting publicly wait here. Approved actions run exactly as shown, once.
      </p>
      {pending.length === 0 && inApps.length === 0 ? <p className="empty">Nothing waiting on you.</p> : null}
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} now={now} />
      ))}
      {inApps.length > 0 ? (
        <section aria-labelledby="app-approvals-h" className="stack">
          <h3 id="app-approvals-h" className="section-title mono">
            Waiting in your apps ({inApps.length})
          </h3>
          <p className="muted small">Each app decides its own approvals. These are copies, kept current by the app.</p>
          {inApps.map((a) => (
            <AppApprovalCard key={`${a.app}:${a.external_id}`} approval={a} now={now} />
          ))}
        </section>
      ) : null}
      {recent.length > 0 ? (
        <section aria-labelledby="recent-approvals-h" className="stack">
          <h3 id="recent-approvals-h" className="section-title mono">
            Recently decided
          </h3>
          {recent.map((a) => (
            <ApprovalCard key={a.id} approval={a} now={now} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
