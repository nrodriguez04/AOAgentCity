import { z } from "zod";
import { EVENT_LEVELS } from "./enums";

// Event contract (spec §5.2). Every agent check-in goes through this schema and
// the city derives every visual effect from these events. The database enforces
// the same type list and summary length (the init migration), so a row that bypasses
// emit() still cannot break the contract.

export const EVENT_TYPES = [
  "run.started",
  "run.progress",
  "run.succeeded",
  "run.failed",
  "approval.requested",
  "approval.decided",
  "action.executed",
  "metric.updated", // e.g. MRR, signups, followers
  "task.created",
  "task.updated",
  "brief.published",
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const EventLevelSchema = z.enum(EVENT_LEVELS);

export const SUMMARY_MAX = 200;

export const AgentEvent = z.object({
  division_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  run_id: z.uuid().optional(),
  type: EventType,
  level: EventLevelSchema.default("info"),
  summary: z.string().min(1).max(SUMMARY_MAX),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/** A validated event, as written to the `events` table. */
export type AgentEvent = z.infer<typeof AgentEvent>;
/** What callers pass to emit(); level and payload are optional. */
export type AgentEventInput = z.input<typeof AgentEvent>;

/** Clamp free text (model output, tool titles) to a valid one-line summary. */
export function toSummary(text: string, max = SUMMARY_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "(no summary)";
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Metric payload convention for `metric.updated` events. emit() merges
 * `payload.metrics` into `divisions.metrics`, which drives the ParlayLab LED
 * band and the CreatorOS billboards.
 */
export const MetricValue = z.object({
  value: z.number(),
  unit: z.enum(["usd", "count", "percent"]).default("count"),
  label: z.string().max(40).optional(),
  delta: z.number().optional(),
  as_of: z.string().optional(),
});
export type MetricValue = z.infer<typeof MetricValue>;

export const MetricsPayload = z.object({
  metrics: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), MetricValue),
});
