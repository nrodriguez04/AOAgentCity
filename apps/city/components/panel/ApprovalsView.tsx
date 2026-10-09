"use client";

import { useCity } from "@/lib/store";
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

  return (
    <div className="stack">
      <p className="muted small">
        Spending money, contacting people and posting publicly wait here. Approved actions run exactly as shown, once.
      </p>
      {pending.length === 0 ? <p className="empty">Nothing waiting on you.</p> : pending.map((a) => <ApprovalCard key={a.id} approval={a} now={now} />)}
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
