"use client";

import { APP_RISK_LABELS, type AppApprovalRow } from "@agent-city/core";
import { useId } from "react";
import { relativeTime } from "@/lib/format";
import { useCity } from "@/lib/store";

/**
 * An approval that lives in a company app (FedOps' bid decisions, for example).
 * The app is the authority: this card shows it and links there, and has no
 * approve button on purpose.
 */
export function AppApprovalCard({ approval, now }: { approval: AppApprovalRow; now: number }) {
  const titleId = useId();
  const app = useCity((s) => s.divisions.find((d) => d.id === approval.division_id)?.name ?? approval.app);
  // The database only stores https links; checked again before it becomes an href.
  const href = approval.url?.startsWith("https://") ? approval.url : null;

  return (
    <article className="approval app-approval" data-status={approval.status} aria-labelledby={titleId}>
      <header className="approval-head">
        <span className="tier-badge" data-tier={approval.risk}>
          {APP_RISK_LABELS[approval.risk]}
        </span>
        <span className="muted mono">
          {app} · {approval.external_id}
        </span>
      </header>

      <h3 id={titleId} className="approval-title">
        {approval.title}
      </h3>

      <p className="muted small">
        Requested {relativeTime(approval.requested_at, now)}
        {approval.expires_at ? ` · expires ${relativeTime(approval.expires_at, now)}` : ""}
      </p>

      <div className="app-approval-decide">
        {href ? (
          <a className="btn btn-small" href={href} target="_blank" rel="noopener noreferrer">
            Decide in {app}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : null}
        <span className="muted small">{href ? `${app} records the decision.` : `Open ${app} to decide it.`}</span>
      </div>
    </article>
  );
}
