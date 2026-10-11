"use client";

import { isAppEventType, type EventRow, type EventType } from "@agent-city/core";
import { relativeTime } from "@/lib/format";
import { useCity } from "@/lib/store";

const TYPE_LABEL: Record<EventType, string> = {
  "run.started": "run",
  "run.progress": "progress",
  "run.succeeded": "done",
  "run.failed": "failed",
  "approval.requested": "approval",
  "approval.decided": "decided",
  "action.executed": "action",
  "metric.updated": "metric",
  "task.created": "task",
  "task.updated": "task",
  "brief.published": "brief",
};

/** An app's own events (fedops.opportunity.qualified) show their verb: "qualified". */
const typeLabel = (type: EventRow["type"]) => (isAppEventType(type) ? type.slice(type.lastIndexOf(".") + 1) : TYPE_LABEL[type]);

export function ActivityFeed({ events, now, showDivision }: { events: EventRow[]; now: number; showDivision?: boolean }) {
  const agents = useCity((s) => s.agents);
  const divisions = useCity((s) => s.divisions);
  if (events.length === 0) return <p className="muted small">No activity yet.</p>;
  return (
    <ol className="feed">
      {events.map((e) => {
        const agent = agents.find((a) => a.id === e.agent_id);
        const division = divisions.find((d) => d.id === e.division_id);
        return (
          <li key={e.id} className="feed-item" data-level={e.level}>
            <span className="feed-type mono" title={isAppEventType(e.type) ? e.type : undefined}>
              {typeLabel(e.type)}
            </span>
            <span className="feed-body">
              <span className="feed-summary">{e.summary}</span>
              <span className="feed-meta muted mono">
                {[showDivision ? division?.name : null, agent?.display_name, relativeTime(e.ts, now)].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
