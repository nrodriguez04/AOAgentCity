import {
  DIVISION_ORDER,
  divisionDefinition,
  formatCompact,
  formatUsd,
  isAppEventType,
  isOpenAppApproval,
  type AgentRow,
  type AppApprovalRow,
  type ApprovalRow,
  type BriefRow,
  type DivisionRow,
  type EventRow,
  type MetricValue,
  type SettingsRow,
} from "@agent-city/core";
import type { BuildingVisuals, CityAmbience, CrownMode, DisplayLine } from "./visual-types";

// The single mapping from event-store state to what the city shows (spec §10.5).
// Pure and synchronous: unit-tested, and kept separate from rendering.

export interface StoreSnapshot {
  divisions: DivisionRow[];
  agents: AgentRow[];
  approvals: ApprovalRow[];
  /** Approvals waiting in company apps; they light the app's beacon like the city's own. */
  appApprovals: AppApprovalRow[];
  /** Recent events, any order. */
  events: EventRow[];
  brief: BriefRow | null;
  settings: SettingsRow | null;
  /** divisionId -> ISO time the owner last acknowledged errors there. */
  acks: Record<string, string>;
  selectedDivisionId: string | null;
}

/** How long after a run.succeeded the edge flash may still start. */
export const FLASH_WINDOW_MS = 4_000;
/** How long the HQ searchlight sweeps after a brief is published. */
export const SEARCHLIGHT_MS = 20 * 60_000;
export const IDLE_LIT = 0.2;
export const DIMMED_LIT = 0.08;

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);

/** Metrics shown first, in this order, when present. */
const METRIC_ORDER = [
  "mrr",
  "active_subscriptions",
  "new_subscriptions_7d",
  "cancellations_7d",
  "failed_payments",
  "past_due_usd",
  "followers",
  "views_7d",
  "engagement_rate",
];

const METRIC_LABELS: Record<string, string> = {
  mrr: "MRR",
  active_subscriptions: "ACTIVE",
  new_subscriptions_7d: "NEW 7D",
  cancellations_7d: "CHURN 7D",
  failed_payments: "FAILED PAY",
  past_due_usd: "PAST DUE",
  followers: "FOLLOWERS",
  views_7d: "VIEWS 7D",
  engagement_rate: "ENGAGEMENT",
};

export function formatMetric(metric: MetricValue): string {
  switch (metric.unit) {
    case "usd":
      return metric.value >= 10_000 ? `$${formatCompact(metric.value)}` : formatUsd(metric.value, 0);
    case "percent":
      return `${metric.value.toFixed(1)}%`;
    default:
      return formatCompact(metric.value);
  }
}

export function displayLines(metrics: Record<string, MetricValue>, max = 6): DisplayLine[] {
  const keys = Object.keys(metrics);
  const ordered = [...METRIC_ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !METRIC_ORDER.includes(k)).sort()];
  return ordered.slice(0, max).map((key) => {
    const metric = metrics[key]!;
    const delta = metric.delta;
    return {
      label: metric.label?.toUpperCase() ?? METRIC_LABELS[key] ?? key.replaceAll("_", " ").toUpperCase(),
      value: formatMetric(metric),
      tone: delta === undefined || delta === 0 ? "neutral" : delta > 0 ? "up" : "down",
    };
  });
}

function crownFor(opts: { underConstruction: boolean; dimmed: boolean; error: boolean; working: boolean; status: DivisionRow["status"] }): CrownMode {
  if (opts.error) return "error";
  if (opts.underConstruction) return "off";
  if (opts.dimmed) return "steady";
  if (opts.working) return "pulse";
  return opts.status === "live" || opts.status === "planning" ? "steady" : "off";
}

export function deriveVisualState(snapshot: StoreSnapshot, now: number = Date.now()): BuildingVisuals[] {
  const cityPaused = Boolean(snapshot.settings?.agents_paused);
  const order = new Map(DIVISION_ORDER.map((id, i) => [id, i]));
  const divisions = [...snapshot.divisions].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  return divisions.flatMap((division): BuildingVisuals[] => {
    const slot = division.city_slot ?? divisionDefinition(division.id)?.slot;
    if (!slot) return [];

    const agents = snapshot.agents.filter((a) => a.division_id === division.id && a.enabled);
    const working = agents.filter((a) => a.state === "working").length;
    const events = snapshot.events.filter((e) => e.division_id === division.id);
    const ackedAt = ms(snapshot.acks[division.id]);

    const pending =
      snapshot.approvals.filter((a) => a.division_id === division.id && a.status === "pending" && ms(a.expires_at) > now).length +
      snapshot.appApprovals.filter((a) => a.division_id === division.id && isOpenAppApproval(a, now)).length;

    // Red crown: an error-level event newer than the last acknowledgement, or an
    // agent currently in the error state that failed after it.
    const lastError = Math.max(0, ...events.filter((e) => e.level === "error").map((e) => ms(e.ts)));
    const agentInError = agents.some((a) => a.state === "error" && ms(a.last_checkin_at) > ackedAt);
    const error = (lastError > 0 && lastError > ackedAt) || agentInError;

    // A finished run, or good news from the division's own app (a pursuit qualified, a deploy shipped).
    const lastSuccess = Math.max(
      0,
      ...events.filter((e) => e.type === "run.succeeded" || (e.level === "success" && isAppEventType(e.type))).map((e) => ms(e.ts)),
    );
    const flashAt = lastSuccess > 0 && now - lastSuccess <= FLASH_WINDOW_MS ? lastSuccess : null;

    let searchlightUntil: number | null = null;
    if (division.id === "hq") {
      const published = Math.max(
        ms(snapshot.brief?.created_at),
        ...events.filter((e) => e.type === "brief.published").map((e) => ms(e.ts)),
      );
      if (published > 0 && now - published < SEARCHLIGHT_MS) searchlightUntil = published + SEARCHLIGHT_MS;
    }

    const underConstruction = division.status === "planned" || division.status === "concept";
    const dimmed = cityPaused || division.status === "paused";

    return [
      {
        divisionId: division.id,
        name: division.name,
        model: slot.buildingModel,
        x: slot.x,
        z: slot.z,
        rotation: slot.rotation ?? 0,
        status: division.status,
        underConstruction,
        dimmed,
        floors: { bands: Math.max(1, agents.length), activeBands: dimmed ? 0 : working },
        ambientLit: dimmed ? DIMMED_LIT : IDLE_LIT,
        crown: crownFor({ underConstruction, dimmed, error, working: working > 0, status: division.status }),
        beacon: { active: pending > 0, count: pending },
        flashAt,
        searchlightUntil: dimmed ? null : searchlightUntil,
        display: displayLines(division.metrics ?? {}),
        selected: snapshot.selectedDivisionId === division.id,
      },
    ];
  });
}

/** Overall run volume in the last hour drives avenue traffic (spec §10.5). */
export function deriveAmbience(snapshot: Pick<StoreSnapshot, "events" | "settings">, lowGraphics: boolean, now: number = Date.now()): CityAmbience {
  const paused = Boolean(snapshot.settings?.agents_paused);
  const runsLastHour = snapshot.events.filter((e) => e.type === "run.started" && now - ms(e.ts) <= 3_600_000).length;
  const trafficDensity = paused ? 0.08 : Math.min(1, 0.18 + runsLastHour / 12);
  return { trafficDensity, paused, lowGraphics };
}
