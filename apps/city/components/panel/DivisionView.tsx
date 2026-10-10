"use client";

import type { AgentRow, DivisionRow, EventRow } from "@agent-city/core";
import { useShallow } from "zustand/react/shallow";
import { relativeTime } from "@/lib/format";
import { useCity } from "@/lib/store";
import type { BuildingVisuals } from "@/lib/visual-types";
import { ActivityFeed } from "./ActivityFeed";
import { ApprovalCard } from "./ApprovalCard";
import { DraftList } from "./DraftList";

const STATE_LABEL: Record<AgentRow["state"], string> = {
  idle: "Idle",
  working: "Working",
  waiting_approval: "Waiting on you",
  error: "Error",
  disabled: "Disabled",
};

const STATUS_LABEL: Record<DivisionRow["status"], string> = {
  concept: "Concept",
  planned: "Planned",
  planning: "Planning",
  live: "Live",
  paused: "Paused",
};

export function StatusPill({ status }: { status: DivisionRow["status"] }) {
  return (
    <span className="status-pill" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DivisionView({ division, building, now }: { division: DivisionRow; building: BuildingVisuals | undefined; now: number }) {
  const agents = useCity(useShallow((s) => s.agents.filter((a) => a.division_id === division.id)));
  const approvals = useCity(useShallow((s) => s.approvals.filter((a) => a.division_id === division.id && a.status === "pending")));
  const allEvents = useCity((s) => s.events);
  const tasks = useCity(useShallow((s) => s.tasks.filter((t) => t.division_id === division.id && ["open", "in_progress", "blocked"].includes(t.status))));
  const acknowledge = useCity((s) => s.acknowledge);
  const brief = useCity((s) => (division.id === "hq" ? s.brief : null));
  const setPanelTab = useCity((s) => s.setPanelTab);
  // HQ shows the newest drafts from every division.
  const drafts = useCity(useShallow((s) => s.drafts.filter((d) => division.id === "hq" || d.division_id === division.id).slice(0, 8)));

  // HQ sees across the whole city; every other division sees its own feed.
  const events: EventRow[] = (division.id === "hq" ? allEvents : allEvents.filter((e) => e.division_id === division.id)).slice(0, 40);

  /** What a working crew is doing right now: its latest per-member progress line. */
  const crewStep = (agent: AgentRow): string | null => {
    if (agent.runtime !== "crewai" || agent.state !== "working") return null;
    return allEvents.find((e) => e.agent_id === agent.id && e.type === "run.progress" && typeof e.payload.member === "string")?.summary ?? null;
  };

  return (
    <div className="division-view">
      <header className="division-head">
        <div>
          <p className="eyebrow mono">{division.kind === "hq" ? "Headquarters" : division.kind}</p>
          <h2 className="division-name">{division.name}</h2>
        </div>
        <StatusPill status={division.status} />
      </header>
      {division.summary ? <p className="division-summary">{division.summary}</p> : null}

      {brief ? (
        <button type="button" className="btn brief-button" onClick={() => setPanelTab("brief")}>
          Open today&apos;s brief <span className="muted small">({relativeTime(brief.created_at, now)})</span>
        </button>
      ) : null}

      {building?.crown === "error" ? (
        <div className="alert alert-error">
          <p>An agent run failed here. The crown stays red until you acknowledge it.</p>
          <button type="button" className="btn btn-small" onClick={() => acknowledge(division.id)}>
            Acknowledge
          </button>
        </div>
      ) : null}

      {building && building.display.length > 0 ? (
        <section aria-labelledby="metrics-h">
          <h3 id="metrics-h" className="section-title mono">
            Metrics
          </h3>
          <dl className="metrics">
            {building.display.map((line) => (
              <div key={line.label} className="metric" data-tone={line.tone ?? "neutral"}>
                <dt className="mono">{line.label}</dt>
                <dd>{line.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section aria-labelledby="agents-h">
        <h3 id="agents-h" className="section-title mono">
          Agents
        </h3>
        {agents.length === 0 ? (
          <p className="muted small">
            {building?.underConstruction ? "Under construction: no agents yet." : "No agents in this division yet."}
          </p>
        ) : (
          <ul className="roster">
            {agents.map((agent) => (
              <li key={agent.id} className="roster-item" data-state={agent.state}>
                <span className="state-dot" aria-hidden="true" />
                <span className="roster-main">
                  <span className="roster-name mono">
                    {agent.display_name}
                    {agent.runtime === "crewai" ? <span className="crew-badge">CrewAI</span> : null}
                  </span>
                  <span className="muted small">{crewStep(agent) ?? agent.role}</span>
                </span>
                <span className="roster-side">
                  <span className="roster-state">{STATE_LABEL[agent.state]}</span>
                  <span className="muted small">checked in {relativeTime(agent.last_checkin_at, now)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {approvals.length > 0 ? (
        <section aria-labelledby="div-approvals-h">
          <h3 id="div-approvals-h" className="section-title mono">
            Waiting on you ({approvals.length})
          </h3>
          <div className="stack">
            {approvals.map((a) => (
              <ApprovalCard key={a.id} approval={a} now={now} />
            ))}
          </div>
        </section>
      ) : null}

      {tasks.length > 0 ? (
        <section aria-labelledby="tasks-h">
          <h3 id="tasks-h" className="section-title mono">
            Open tasks
          </h3>
          <ul className="tasks">
            {tasks.map((t) => (
              <li key={t.id} className="task">
                <span className="task-priority mono">P{t.priority}</span>
                <span>{t.title}</span>
                <span className="muted small">{t.owner === "nico" ? "You" : t.owner}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {drafts.length > 0 ? (
        <section aria-labelledby="drafts-h">
          <h3 id="drafts-h" className="section-title mono">
            {division.id === "hq" ? "Latest drafts" : "Drafts"}
          </h3>
          <DraftList drafts={drafts} now={now} showDivision={division.id === "hq"} />
        </section>
      ) : null}

      <section aria-labelledby="activity-h">
        <h3 id="activity-h" className="section-title mono">
          {division.id === "hq" ? "City activity" : "Recent activity"}
        </h3>
        <ActivityFeed events={events} now={now} showDivision={division.id === "hq"} />
      </section>
    </div>
  );
}
