"use client";

import ReactMarkdown from "react-markdown";
import { dateTime } from "@/lib/format";
import { useCity } from "@/lib/store";

export function BriefView() {
  const brief = useCity((s) => s.brief);
  if (!brief) {
    return <p className="empty">No brief yet. HQ-01 publishes one every morning at 7:00.</p>;
  }
  return (
    <article className="brief">
      <p className="muted small mono">Published {dateTime(brief.created_at)} by HQ-01</p>
      <div className="markdown">
        <ReactMarkdown>{brief.body_md}</ReactMarkdown>
      </div>
    </article>
  );
}
