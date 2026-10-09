// Enum values shared by the database (supabase/migrations/0001_init.sql),
// the worker, and the city. Keep these lists in the same order as the SQL enums.

export const DIVISION_KINDS = ["hq", "business", "personal", "creator"] as const;
export type DivisionKind = (typeof DIVISION_KINDS)[number];

export const DIVISION_STATUSES = ["concept", "planned", "planning", "live", "paused"] as const;
export type DivisionStatus = (typeof DIVISION_STATUSES)[number];

export const AGENT_STATES = ["idle", "working", "waiting_approval", "error", "disabled"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RISK_TIERS = ["read", "internal_write", "external_effect", "financial"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

// "executing" is not in the original spec enum. It is the claimed state between
// "approved" and "executed"/"failed" that makes execution idempotent (spec §7.3).
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "executing",
  "rejected",
  "expired",
  "executed",
  "failed",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Approvals in these states still hold their action open (used for dedupe). */
export const OPEN_APPROVAL_STATUSES = ["pending", "approved", "executing"] as const satisfies readonly ApprovalStatus[];

export const EVENT_LEVELS = ["info", "success", "warning", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "parked", "killed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MODEL_TIERS = ["reasoning", "standard", "fast"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const RUN_TRIGGERS = ["cron", "hq", "manual", "approval"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const TOOL_CALL_STATUSES = ["ok", "error", "denied", "invalid", "pending_approval"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
