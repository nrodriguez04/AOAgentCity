"use client";

import type { DraftRow } from "@agent-city/core";
import ReactMarkdown from "react-markdown";
import { relativeTime } from "@/lib/format";

const KIND_LABEL: Record<DraftRow["kind"], string> = {
  devlog: "Devlog",
  social_post: "Post",
  article: "Article",
  newsletter: "Newsletter",
  report: "Report",
  plan: "Plan",
  other: "Draft",
};

/** Documents agents and crews wrote for review. Each opens to its full text; nothing here publishes. */
export function DraftList({ drafts, now, showDivision = false }: { drafts: DraftRow[]; now: number; showDivision?: boolean }) {
  if (drafts.length === 0) return <p className="muted small">No drafts yet.</p>;
  return (
    <ul className="drafts">
      {drafts.map((d) => (
        <li key={d.id}>
          <details className="draft" data-kind={d.kind}>
            <summary>
              <span className="draft-kind mono">{KIND_LABEL[d.kind]}</span>
              <span className="draft-title">{d.title}</span>
              <span className="muted small draft-meta">
                {[showDivision ? d.division_id : null, d.channel, relativeTime(d.created_at, now)].filter(Boolean).join(" · ")}
              </span>
            </summary>
            <div className="markdown draft-body">
              <ReactMarkdown>{d.body_md}</ReactMarkdown>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
