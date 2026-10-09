"use client";

import { useRef, type KeyboardEvent } from "react";
import { useCity, type PanelTab } from "@/lib/store";
import type { BuildingVisuals } from "@/lib/visual-types";
import { ApprovalsView } from "./ApprovalsView";
import { BriefView } from "./BriefView";
import { DivisionView } from "./DivisionView";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "division", label: "Division" },
  { id: "approvals", label: "Approvals" },
  { id: "brief", label: "Brief" },
];

export function SidePanel({ buildings, now }: { buildings: BuildingVisuals[]; now: number }) {
  const tab = useCity((s) => s.panelTab);
  const setTab = useCity((s) => s.setPanelTab);
  const open = useCity((s) => s.panelOpen);
  const setOpen = useCity((s) => s.setPanelOpen);
  const selectedId = useCity((s) => s.selectedDivisionId);
  const division = useCity((s) => s.divisions.find((d) => d.id === (s.selectedDivisionId ?? "hq")));
  const pendingCount = useCity((s) => s.approvals.filter((a) => a.status === "pending" && new Date(a.expires_at).getTime() > now).length);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Arrow-key navigation between tabs (WAI-ARIA tabs pattern, automatic activation).
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next >= 0) {
      e.preventDefault();
      setTab(TABS[next]!.id);
      tabRefs.current[TABS[next]!.id]?.focus();
    }
  }

  if (!open) return null;

  return (
    <aside className="side-panel glass" aria-label="City details">
      <div className="panel-tabs">
        <div role="tablist" aria-label="Panel sections" onKeyDown={onKeyDown} className="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`tabpanel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="tab"
              onClick={() => setTab(t.id)}
            >
              {t.id === "division" ? (division?.name ?? t.label) : t.label}
              {t.id === "approvals" && pendingCount > 0 ? <span className="count-badge">{pendingCount}</span> : null}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Hide panel" onClick={() => setOpen(false)}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="panel-body">
        {tab === "division" && division ? (
          <DivisionView division={division} building={buildings.find((b) => b.divisionId === (selectedId ?? "hq"))} now={now} />
        ) : null}
        {tab === "approvals" ? <ApprovalsView now={now} /> : null}
        {tab === "brief" ? <BriefView /> : null}
      </div>
    </aside>
  );
}
