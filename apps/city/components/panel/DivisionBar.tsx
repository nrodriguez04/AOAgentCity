"use client";

import { useCity } from "@/lib/store";
import type { BuildingVisuals } from "@/lib/visual-types";

export function DivisionBar({ buildings }: { buildings: BuildingVisuals[] }) {
  const selectedId = useCity((s) => s.selectedDivisionId);
  const select = useCity((s) => s.selectDivision);

  return (
    <nav className="division-bar glass" aria-label="Divisions">
      <ul>
        {buildings.map((b) => {
          const working = b.floors.activeBands > 0;
          const description = [
            b.status,
            working ? `${b.floors.activeBands} agent${b.floors.activeBands > 1 ? "s" : ""} working` : null,
            b.beacon.count ? `${b.beacon.count} waiting on you` : null,
            b.crown === "error" ? "needs attention" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <li key={b.divisionId}>
              <button
                type="button"
                className="division-chip"
                data-status={b.status}
                data-working={working || undefined}
                data-error={b.crown === "error" || undefined}
                aria-pressed={selectedId === b.divisionId}
                aria-label={`${b.name}: ${description}`}
                onClick={() => select(b.divisionId, { focus: true })}
              >
                <span className="chip-dot" aria-hidden="true" />
                <span className="chip-name">{b.name}</span>
                {b.beacon.count > 0 ? (
                  <span className="count-badge" aria-hidden="true">
                    {b.beacon.count}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
