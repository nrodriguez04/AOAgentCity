"use client";

import { formatMinorUnits, TIER_LABELS, type ApprovalRow } from "@agent-city/core";
import { useId, useState } from "react";
import { decideApproval } from "@/lib/actions";
import { relativeTime } from "@/lib/format";
import { useCity } from "@/lib/store";
import { announce } from "./Announcer";

export function ApprovalCard({ approval, now }: { approval: ApprovalRow; now: number }) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agent = useCity((s) => s.agents.find((a) => a.id === approval.agent_id));
  const division = useCity((s) => s.divisions.find((d) => d.id === approval.division_id));
  const pending = approval.status === "pending";
  const financial = approval.tier === "financial";

  async function decide(decision: "approved" | "rejected") {
    setBusy(decision);
    setError(null);
    const result = await decideApproval(approval.id, decision, note || null);
    setBusy(null);
    if (result.ok) announce(`${decision === "approved" ? "Approved" : "Rejected"}: ${approval.title}`);
    else setError(result.error);
  }

  return (
    <article className="approval" data-tier={approval.tier} data-status={approval.status} aria-labelledby={`${noteId}-title`}>
      <header className="approval-head">
        <span className="tier-badge" data-tier={approval.tier}>
          {TIER_LABELS[approval.tier]}
        </span>
        <span className="muted mono">
          {agent?.display_name ?? approval.agent_id} · {division?.name ?? approval.division_id}
        </span>
      </header>

      <h3 id={`${noteId}-title`} className="approval-title">
        {approval.title}
      </h3>

      {financial && approval.amount_cents !== null ? (
        <p className="approval-amount">{formatMinorUnits(approval.amount_cents, approval.currency ?? "usd")}</p>
      ) : null}

      <p className="approval-rationale">{approval.rationale}</p>

      <details className="approval-action">
        <summary>Exact action that will run</summary>
        <pre>{JSON.stringify(approval.action, null, 2)}</pre>
      </details>

      <p className="muted small">
        Requested {relativeTime(approval.created_at, now)}
        {pending ? ` · expires ${relativeTime(approval.expires_at, now)}` : ` · ${approval.status}${approval.decided_at ? ` ${relativeTime(approval.decided_at, now)}` : ""}`}
        {approval.decided_note ? ` · “${approval.decided_note}”` : ""}
      </p>

      {pending ? (
        <div className="approval-decide">
          <label htmlFor={noteId} className="label">
            Note <span className="muted">(optional)</span>
          </label>
          <textarea id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <div className="approval-buttons">
            <button type="button" className="btn btn-approve" disabled={busy !== null} onClick={() => decide("approved")}>
              {busy === "approved" ? "Approving…" : financial ? `Approve ${formatMinorUnits(approval.amount_cents ?? 0, approval.currency ?? "usd")}` : "Approve"}
            </button>
            <button type="button" className="btn btn-reject" disabled={busy !== null} onClick={() => decide("rejected")}>
              {busy === "rejected" ? "Rejecting…" : "Reject"}
            </button>
          </div>
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : approval.result ? (
        <details className="approval-action">
          <summary>Result</summary>
          <pre>{JSON.stringify(approval.result, null, 2)}</pre>
        </details>
      ) : null}
    </article>
  );
}
