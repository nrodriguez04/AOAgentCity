import type {
  AgentRuntime,
  AgentState,
  ApprovalStatus,
  DivisionKind,
  DivisionStatus,
  DraftKind,
  DraftStatus,
  EventLevel,
  ModelTier,
  RiskTier,
  RunStatus,
  TaskStatus,
  ToolCallStatus,
} from "./enums";
import type { AppEventType } from "./apps";
import type { EventType, MetricValue } from "./events";
import type { BuildingModel } from "./divisions";

// Row shapes for the tables in supabase/migrations. Timestamps are ISO strings
// (that is what Supabase Realtime delivers to the city), numerics are numbers.

export interface CitySlot {
  /** World-space position of the hero lot centre (city units, +z is south). */
  x: number;
  z: number;
  buildingModel: BuildingModel;
  /** Optional rotation in radians around the vertical axis. */
  rotation?: number;
}

export interface DivisionRow {
  id: string;
  name: string;
  kind: DivisionKind;
  status: DivisionStatus;
  summary: string | null;
  context_md: string | null;
  city_slot: CitySlot | null;
  metrics: Record<string, MetricValue>;
  created_at: string;
}

export interface AgentRow {
  id: string;
  division_id: string;
  display_name: string;
  role: string;
  model_tier: ModelTier;
  /** "crewai" rows are crews: they run on CrewAI AMP instead of the Claude loop. */
  runtime: AgentRuntime;
  instructions: string;
  default_goal: string | null;
  schedule_cron: string | null;
  state: AgentState;
  last_checkin_at: string | null;
  daily_budget_usd: number;
  enabled: boolean;
  created_at: string;
}

export interface AgentPermissionRow {
  agent_id: string;
  tool_name: string;
  max_tier: RiskTier;
}

export interface RunRow {
  id: string;
  agent_id: string;
  trigger: string;
  goal: string | null;
  status: RunStatus;
  model: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  error: string | null;
  transcript: unknown;
  /** The HQ run that dispatched this one, if any. */
  parent_run_id: string | null;
  /** Shared by every run in a dispatch chain (the root run's id). */
  correlation_id: string | null;
  /** When the owner was emailed about this run's failure. */
  notified_at: string | null;
}

export interface EventRow {
  id: number;
  ts: string;
  division_id: string;
  agent_id: string | null;
  run_id: string | null;
  /** Agent City's own event types, or a connected app's namespaced ones (fedops.opportunity.qualified). */
  type: EventType | AppEventType;
  level: EventLevel;
  summary: string;
  payload: Record<string, unknown>;
}

/** The exact action an approval executes (spec §7.3: executed verbatim). */
export interface ApprovalAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface ApprovalRow {
  id: string;
  created_at: string;
  division_id: string;
  agent_id: string;
  run_id: string | null;
  tier: RiskTier;
  title: string;
  rationale: string;
  action: ApprovalAction;
  action_hash: string;
  amount_cents: number | null;
  currency: string | null;
  status: ApprovalStatus;
  decided_at: string | null;
  decided_note: string | null;
  expires_at: string;
  executed_at: string | null;
  result: unknown;
  /** auth.users id of the owner who approved or rejected it (stamped by the database). */
  decided_by: string | null;
  /** When the owner was emailed about it. */
  notified_at: string | null;
}

export interface TaskRow {
  id: string;
  division_id: string;
  title: string;
  notes: string | null;
  owner: string;
  status: TaskStatus;
  priority: number;
  due_at: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface BriefRow {
  id: string;
  created_at: string;
  body_md: string;
  run_id: string | null;
  /** When the brief was emailed to the owner. */
  notified_at: string | null;
}

/** One owner alert email (kind "digest": approvals and failures; "brief": HQ's brief). No address is stored. */
export interface NotificationRow {
  id: string;
  created_at: string;
  kind: "digest" | "brief";
  channel: "email";
  subject: string;
  item_count: number;
  status: "sent" | "failed";
  provider_message_id: string | null;
  error: string | null;
}

export interface SettingsRow {
  agents_paused: boolean;
  trigger_api_url: string;
  updated_at: string;
}

export interface ModelPricingRow {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_5m_per_mtok: number;
  cache_write_1h_per_mtok: number;
  cache_read_per_mtok: number;
  /** Prompts above this many tokens bill at the long-context rates, if set. */
  long_context_threshold: number | null;
  long_input_per_mtok: number | null;
  long_output_per_mtok: number | null;
}

export interface ToolCallRow {
  id: number;
  ts: string;
  run_id: string | null;
  agent_id: string;
  tool_name: string;
  tier: RiskTier | null;
  status: ToolCallStatus;
  args: unknown;
  result: unknown;
  duration_ms: number | null;
}

export interface EmailDraftRow {
  id: string;
  created_at: string;
  division_id: string;
  agent_id: string;
  run_id: string | null;
  to_addr: string;
  subject: string;
  body_text: string;
  thread_id: string | null;
  in_reply_to: string | null;
  status: "draft" | "queued" | "sent" | "discarded";
}

/** A document an agent or crew wrote for Nico to review (devlog, post, report, plan). */
export interface DraftRow {
  id: string;
  created_at: string;
  division_id: string;
  agent_id: string;
  run_id: string | null;
  kind: DraftKind;
  channel: string | null;
  title: string;
  body_md: string;
  status: DraftStatus;
  updated_at: string;
  /** When and by whom (auth.users id) Nico last changed it in the city. */
  reviewed_at: string | null;
  reviewed_by: string | null;
  /** The agent's original text, kept the first time Nico edits the body. */
  original_body_md: string | null;
  /** Where Nico posted it, once published. */
  published_url: string | null;
}

/** What the city may change on a draft (RLS allows exactly these columns for the owner). */
export type DraftReview = Partial<Pick<DraftRow, "status" | "title" | "body_md" | "published_url">>;

/** A knowledge document: strategy, rules, decisions or lessons for one division. */
export interface DocumentRow {
  id: string;
  division_id: string;
  /** Unique within the division: lowercase letters, digits and hyphens. */
  slug: string;
  title: string;
  body_md: string;
  tags: string[];
  archived: boolean;
  /** Starts at 1; every edit to title, text or tags keeps the old version and adds one. */
  version: number;
  created_at: string;
  updated_at: string;
  /** "owner" when Nico last edited it in the city, else the agent id that saved it. */
  updated_by: string;
}

/** What the city may set on a document (RLS allows exactly these columns for the owner). */
export type DocumentInput = Pick<DocumentRow, "division_id" | "slug" | "title" | "body_md" | "tags">;
export type DocumentEdit = Partial<Pick<DocumentRow, "title" | "body_md" | "tags" | "archived">>;
