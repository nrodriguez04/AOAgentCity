import type {
  AgentEvent,
  AgentPermissionRow,
  AgentRow,
  AgentRuntime,
  AgentState,
  ApprovalAction,
  ApprovalRow,
  ApprovalStatus,
  BriefRow,
  CitySlot,
  DivisionKind,
  DivisionRow,
  DivisionStatus,
  DraftKind,
  DraftRow,
  DraftStatus,
  EmailDraftRow,
  EventRow,
  EventType,
  MetricValue,
  ModelPricingRow,
  ModelTier,
  NotificationRow,
  RiskTier,
  RunRow,
  RunStatus,
  RunTrigger,
  SettingsRow,
  TaskRow,
  TaskStatus,
  ToolCallStatus,
} from "@agent-city/core";
import type { SqlClient } from "./sql";

type Raw = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const isoNow = (v: unknown): string => iso(v) ?? new Date(0).toISOString();
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const list = (values: readonly string[]): string => values.join(",");
const json = (v: unknown): string => JSON.stringify(v ?? null);

function mapDivision(r: Raw): DivisionRow {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: r.kind as DivisionKind,
    status: r.status as DivisionStatus,
    summary: (r.summary as string | null) ?? null,
    context_md: (r.context_md as string | null) ?? null,
    city_slot: (r.city_slot as CitySlot | null) ?? null,
    metrics: (r.metrics as Record<string, MetricValue>) ?? {},
    created_at: isoNow(r.created_at),
  };
}

function mapAgent(r: Raw): AgentRow {
  return {
    id: String(r.id),
    division_id: String(r.division_id),
    display_name: String(r.display_name),
    role: String(r.role),
    model_tier: r.model_tier as ModelTier,
    runtime: ((r.runtime as AgentRuntime | null) ?? "claude") as AgentRuntime,
    instructions: String(r.instructions),
    default_goal: (r.default_goal as string | null) ?? null,
    schedule_cron: (r.schedule_cron as string | null) ?? null,
    state: r.state as AgentState,
    last_checkin_at: iso(r.last_checkin_at),
    daily_budget_usd: num(r.daily_budget_usd),
    enabled: Boolean(r.enabled),
    created_at: isoNow(r.created_at),
  };
}

function mapRun(r: Raw): RunRow {
  return {
    id: String(r.id),
    agent_id: String(r.agent_id),
    trigger: String(r.trigger),
    goal: (r.goal as string | null) ?? null,
    status: r.status as RunStatus,
    model: (r.model as string | null) ?? null,
    created_at: isoNow(r.created_at),
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cache_read_tokens: num(r.cache_read_tokens),
    cache_write_tokens: num(r.cache_write_tokens),
    cost_usd: num(r.cost_usd),
    error: (r.error as string | null) ?? null,
    transcript: r.transcript ?? null,
    parent_run_id: (r.parent_run_id as string | null) ?? null,
    correlation_id: (r.correlation_id as string | null) ?? null,
    notified_at: iso(r.notified_at),
  };
}

function mapEvent(r: Raw): EventRow {
  return {
    id: num(r.id),
    ts: isoNow(r.ts),
    division_id: String(r.division_id),
    agent_id: (r.agent_id as string | null) ?? null,
    run_id: (r.run_id as string | null) ?? null,
    type: r.type as EventType,
    level: r.level as EventRow["level"],
    summary: String(r.summary),
    payload: (r.payload as Record<string, unknown>) ?? {},
  };
}

function mapApproval(r: Raw): ApprovalRow {
  return {
    id: String(r.id),
    created_at: isoNow(r.created_at),
    division_id: String(r.division_id),
    agent_id: String(r.agent_id),
    run_id: (r.run_id as string | null) ?? null,
    tier: r.tier as RiskTier,
    title: String(r.title),
    rationale: String(r.rationale),
    action: r.action as ApprovalAction,
    action_hash: String(r.action_hash),
    amount_cents: numOrNull(r.amount_cents),
    currency: (r.currency as string | null) ?? null,
    status: r.status as ApprovalStatus,
    decided_at: iso(r.decided_at),
    decided_note: (r.decided_note as string | null) ?? null,
    expires_at: isoNow(r.expires_at),
    executed_at: iso(r.executed_at),
    result: r.result ?? null,
    decided_by: (r.decided_by as string | null) ?? null,
    notified_at: iso(r.notified_at),
  };
}

function mapTask(r: Raw): TaskRow {
  return {
    id: String(r.id),
    division_id: String(r.division_id),
    title: String(r.title),
    notes: (r.notes as string | null) ?? null,
    owner: String(r.owner),
    status: r.status as TaskStatus,
    priority: num(r.priority),
    due_at: iso(r.due_at),
    source: (r.source as string | null) ?? null,
    created_at: isoNow(r.created_at),
    updated_at: isoNow(r.updated_at),
  };
}

function mapBrief(r: Raw): BriefRow {
  return {
    id: String(r.id),
    created_at: isoNow(r.created_at),
    body_md: String(r.body_md),
    run_id: (r.run_id as string | null) ?? null,
    notified_at: iso(r.notified_at),
  };
}

function mapNotification(r: Raw): NotificationRow {
  return {
    id: String(r.id),
    created_at: isoNow(r.created_at),
    kind: r.kind as NotificationRow["kind"],
    channel: "email",
    subject: String(r.subject),
    item_count: num(r.item_count),
    status: r.status as NotificationRow["status"],
    provider_message_id: (r.provider_message_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

function mapPricing(r: Raw): ModelPricingRow {
  return {
    model: String(r.model),
    input_per_mtok: num(r.input_per_mtok),
    output_per_mtok: num(r.output_per_mtok),
    cache_write_5m_per_mtok: num(r.cache_write_5m_per_mtok),
    cache_write_1h_per_mtok: num(r.cache_write_1h_per_mtok),
    cache_read_per_mtok: num(r.cache_read_per_mtok),
    long_context_threshold: numOrNull(r.long_context_threshold),
    long_input_per_mtok: numOrNull(r.long_input_per_mtok),
    long_output_per_mtok: numOrNull(r.long_output_per_mtok),
  };
}

function mapDocument(r: Raw): DraftRow {
  return {
    id: String(r.id),
    created_at: isoNow(r.created_at),
    division_id: String(r.division_id),
    agent_id: String(r.agent_id),
    run_id: (r.run_id as string | null) ?? null,
    kind: r.kind as DraftKind,
    channel: (r.channel as string | null) ?? null,
    title: String(r.title),
    body_md: String(r.body_md),
    status: r.status as DraftStatus,
  };
}

function mapDraft(r: Raw): EmailDraftRow {
  return {
    id: String(r.id),
    created_at: isoNow(r.created_at),
    division_id: String(r.division_id),
    agent_id: String(r.agent_id),
    run_id: (r.run_id as string | null) ?? null,
    to_addr: String(r.to_addr),
    subject: String(r.subject),
    body_text: String(r.body_text),
    thread_id: (r.thread_id as string | null) ?? null,
    in_reply_to: (r.in_reply_to as string | null) ?? null,
    status: r.status as EmailDraftRow["status"],
  };
}

export interface NewApproval {
  division_id: string;
  agent_id: string;
  run_id: string | null;
  tier: RiskTier;
  title: string;
  rationale: string;
  action: ApprovalAction;
  action_hash: string;
  amount_cents?: number | null;
  currency?: string | null;
  expires_at?: Date | null;
}

export interface RunPatch {
  status?: RunStatus;
  model?: string | null;
  ended_at?: Date | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
  error?: string | null;
  transcript?: unknown;
}

export interface NewDraft {
  division_id: string;
  agent_id: string;
  run_id: string | null;
  kind: DraftKind;
  channel: string | null;
  title: string;
  body_md: string;
}

export interface NewTask {
  division_id: string;
  title: string;
  notes?: string | null;
  owner?: string;
  status?: TaskStatus;
  priority?: number;
  due_at?: Date | null;
  source?: string | null;
}

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  owner?: string;
  status?: TaskStatus;
  priority?: number;
  due_at?: Date | null;
}

export interface ToolCallLog {
  run_id: string | null;
  agent_id: string;
  tool_name: string;
  tier: RiskTier | null;
  status: ToolCallStatus;
  args: unknown;
  result: unknown;
  duration_ms?: number | null;
}

export interface DivisionUpsert {
  id: string;
  name: string;
  kind: DivisionKind;
  status: DivisionStatus;
  summary: string | null;
  context_md: string | null;
  city_slot: CitySlot | null;
}

export interface AgentUpsert {
  id: string;
  division_id: string;
  display_name: string;
  role: string;
  model_tier: ModelTier;
  /** Defaults to "claude". */
  runtime?: AgentRuntime;
  instructions: string;
  default_goal: string | null;
  schedule_cron: string | null;
  daily_budget_usd: number;
  enabled: boolean;
}

/**
 * Typed access to the Agent City tables. One instance per process is enough; it
 * holds no state besides the SQL client.
 */
export class Repo {
  constructor(readonly sql: SqlClient) {}

  // ---------------------------------------------------------------- settings

  async getSettings(): Promise<SettingsRow> {
    const [row] = await this.sql.query<Raw>(`select agents_paused, trigger_api_url, updated_at from settings where id`);
    return {
      agents_paused: Boolean(row?.agents_paused),
      trigger_api_url: String(row?.trigger_api_url ?? "https://api.trigger.dev"),
      updated_at: isoNow(row?.updated_at),
    };
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.sql.query(`update settings set agents_paused = $1 where id`, [paused]);
  }

  // --------------------------------------------------------------- divisions

  async listDivisions(): Promise<DivisionRow[]> {
    return (await this.sql.query<Raw>(`select * from divisions order by created_at, id`)).map(mapDivision);
  }

  async getDivision(id: string): Promise<DivisionRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from divisions where id = $1`, [id]);
    return row ? mapDivision(row) : null;
  }

  async updateDivisionContext(id: string, contextMd: string): Promise<boolean> {
    const rows = await this.sql.query(`update divisions set context_md = $2 where id = $1 returning id`, [id, contextMd]);
    return rows.length > 0;
  }

  async mergeDivisionMetrics(id: string, metrics: Record<string, MetricValue>): Promise<void> {
    await this.sql.query(`update divisions set metrics = metrics || $2::jsonb where id = $1`, [id, json(metrics)]);
  }

  /** Used by agents:sync. Keeps live metrics and created_at. */
  async upsertDivision(d: DivisionUpsert): Promise<void> {
    await this.sql.query(
      `insert into divisions (id, name, kind, status, summary, context_md, city_slot)
       values ($1, $2, $3, $4::division_status, $5, $6, $7::jsonb)
       on conflict (id) do update set
         name = excluded.name, kind = excluded.kind, summary = excluded.summary,
         city_slot = excluded.city_slot,
         status = excluded.status,
         context_md = coalesce(divisions.context_md, excluded.context_md)`,
      [d.id, d.name, d.kind, d.status, d.summary, d.context_md, json(d.city_slot)],
    );
  }

  // ------------------------------------------------------------------ agents

  async getAgent(id: string): Promise<AgentRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from agents where id = $1`, [id]);
    return row ? mapAgent(row) : null;
  }

  async listAgents(divisionId?: string): Promise<AgentRow[]> {
    const rows = divisionId
      ? await this.sql.query<Raw>(`select * from agents where division_id = $1 order by id`, [divisionId])
      : await this.sql.query<Raw>(`select * from agents order by division_id, id`);
    return rows.map(mapAgent);
  }

  async setAgentState(id: string, state: AgentState): Promise<void> {
    await this.sql.query(`update agents set state = $2::agent_state where id = $1`, [id, state]);
  }

  async upsertAgent(a: AgentUpsert): Promise<void> {
    await this.sql.query(
      `insert into agents (id, division_id, display_name, role, model_tier, instructions, default_goal,
                           schedule_cron, daily_budget_usd, enabled, state, runtime)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10,
               case when $10 then 'idle' else 'disabled' end::agent_state, $11)
       on conflict (id) do update set
         division_id = excluded.division_id, display_name = excluded.display_name, role = excluded.role,
         model_tier = excluded.model_tier, runtime = excluded.runtime, instructions = excluded.instructions,
         default_goal = excluded.default_goal, schedule_cron = excluded.schedule_cron,
         daily_budget_usd = excluded.daily_budget_usd, enabled = excluded.enabled,
         state = case
           when not excluded.enabled then 'disabled'::agent_state
           when agents.state = 'disabled' then 'idle'::agent_state
           else agents.state end`,
      [a.id, a.division_id, a.display_name, a.role, a.model_tier, a.instructions, a.default_goal, a.schedule_cron, a.daily_budget_usd, a.enabled, a.runtime ?? "claude"],
    );
  }

  /** Replace an agent's tool grants with exactly this set. */
  async replacePermissions(agentId: string, permissions: { tool_name: string; max_tier: RiskTier }[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.query(`delete from agent_permissions where agent_id = $1`, [agentId]);
      for (const p of permissions) {
        await tx.query(`insert into agent_permissions (agent_id, tool_name, max_tier) values ($1, $2, $3::risk_tier)`, [
          agentId,
          p.tool_name,
          p.max_tier,
        ]);
      }
    });
  }

  async getPermission(agentId: string, toolName: string): Promise<AgentPermissionRow | null> {
    const [row] = await this.sql.query<Raw>(
      `select agent_id, tool_name, max_tier from agent_permissions where agent_id = $1 and tool_name = $2`,
      [agentId, toolName],
    );
    return row ? { agent_id: String(row.agent_id), tool_name: String(row.tool_name), max_tier: row.max_tier as RiskTier } : null;
  }

  async listPermissions(agentId: string): Promise<AgentPermissionRow[]> {
    const rows = await this.sql.query<Raw>(
      `select agent_id, tool_name, max_tier from agent_permissions where agent_id = $1 order by tool_name`,
      [agentId],
    );
    return rows.map((r) => ({ agent_id: String(r.agent_id), tool_name: String(r.tool_name), max_tier: r.max_tier as RiskTier }));
  }

  // -------------------------------------------------------------------- runs

  /**
   * Start a run. A run dispatched by another run (HQ) records it as parent and
   * joins its correlation chain; every other run starts its own chain.
   */
  async createRun(input: {
    agent_id: string;
    trigger: RunTrigger;
    goal: string | null;
    model: string | null;
    parent_run_id?: string | null;
  }): Promise<RunRow> {
    const [row] = await this.sql.query<Raw>(
      `with new_run as (select gen_random_uuid() as id),
            parent as (select id, correlation_id from runs where id = $5::uuid)
       insert into runs (id, agent_id, trigger, goal, model, status, started_at, parent_run_id, correlation_id)
       select n.id, $1, $2, $3, $4, 'running', now(), (select id from parent),
              coalesce((select coalesce(correlation_id, id) from parent), n.id)
         from new_run n
       returning *`,
      [input.agent_id, input.trigger, input.goal, input.model, input.parent_run_id ?? null],
    );
    return mapRun(row!);
  }

  async updateRun(id: string, patch: RunPatch): Promise<RunRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.status !== undefined) add("status", patch.status, "::run_status");
    if (patch.model !== undefined) add("model", patch.model);
    if (patch.ended_at !== undefined) add("ended_at", patch.ended_at, "::timestamptz");
    if (patch.input_tokens !== undefined) add("input_tokens", Math.round(patch.input_tokens), "::int");
    if (patch.output_tokens !== undefined) add("output_tokens", Math.round(patch.output_tokens), "::int");
    if (patch.cache_read_tokens !== undefined) add("cache_read_tokens", Math.round(patch.cache_read_tokens), "::int");
    if (patch.cache_write_tokens !== undefined) add("cache_write_tokens", Math.round(patch.cache_write_tokens), "::int");
    if (patch.cost_usd !== undefined) add("cost_usd", patch.cost_usd, "::numeric");
    if (patch.error !== undefined) add("error", patch.error);
    if (patch.transcript !== undefined) add("transcript", json(patch.transcript), "::jsonb");
    if (sets.length === 0) return this.getRun(id);
    const [row] = await this.sql.query<Raw>(`update runs set ${sets.join(", ")} where id = $1::uuid returning *`, params);
    return row ? mapRun(row) : null;
  }

  async getRun(id: string): Promise<RunRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from runs where id = $1::uuid`, [id]);
    return row ? mapRun(row) : null;
  }

  /** Lightweight run listing without transcripts. */
  async listRuns(filter: { agentId?: string; statuses?: RunStatus[]; since?: Date; limit?: number } = {}): Promise<RunRow[]> {
    const rows = await this.sql.query<Raw>(
      `select id, agent_id, trigger, goal, status, model, created_at, started_at, ended_at, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, error, null as transcript
         from runs
        where ($1::text is null or agent_id = $1)
          and ($2::text is null or status::text = any(string_to_array($2, ',')))
          and ($3::timestamptz is null or created_at >= $3)
        order by created_at desc
        limit $4::int`,
      [filter.agentId ?? null, filter.statuses ? list(filter.statuses) : null, filter.since ?? null, filter.limit ?? 50],
    );
    return rows.map(mapRun);
  }

  async agentSpendSince(agentId: string, since: Date): Promise<number> {
    const [row] = await this.sql.query<Raw>(
      `select coalesce(sum(cost_usd), 0) as total from runs where agent_id = $1 and created_at >= $2::timestamptz`,
      [agentId, since],
    );
    return num(row?.total);
  }

  async recentRunCosts(agentId: string, limit = 5): Promise<number[]> {
    const rows = await this.sql.query<Raw>(
      `select cost_usd from runs where agent_id = $1 and status in ('succeeded', 'waiting_approval')
        order by created_at desc limit $2::int`,
      [agentId, limit],
    );
    return rows.map((r) => num(r.cost_usd));
  }

  async spendByDivision(since: Date, until?: Date): Promise<{ division_id: string; runs: number; cost_usd: number }[]> {
    const rows = await this.sql.query<Raw>(
      `select a.division_id, count(r.id) as runs, coalesce(sum(r.cost_usd), 0) as cost_usd
         from runs r join agents a on a.id = r.agent_id
        where r.created_at >= $1::timestamptz and ($2::timestamptz is null or r.created_at < $2)
        group by a.division_id
        order by a.division_id`,
      [since, until ?? null],
    );
    return rows.map((r) => ({ division_id: String(r.division_id), runs: num(r.runs), cost_usd: num(r.cost_usd) }));
  }

  /** Runs still marked running long after they should have ended (crashed workers). */
  async listStaleRunningRuns(olderThan: Date): Promise<RunRow[]> {
    const rows = await this.sql.query<Raw>(
      `select id, agent_id, trigger, goal, status, model, created_at, started_at, ended_at, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, error, null as transcript
         from runs where status = 'running' and started_at < $1::timestamptz`,
      [olderThan],
    );
    return rows.map(mapRun);
  }

  // ------------------------------------------------------------------ events

  /**
   * Insert a validated event and check the agent in, in one statement. Pass
   * `agentState = null` to update last_checkin_at without changing state.
   */
  async insertEventAndCheckin(event: AgentEvent, agentState: AgentState | null): Promise<EventRow> {
    const [row] = await this.sql.query<Raw>(
      `with ev as (
         insert into events (division_id, agent_id, run_id, type, level, summary, payload)
         values ($1, $2, $3::uuid, $4, $5::event_level, $6, $7::jsonb)
         returning *
       ), checkin as (
         update agents
            set state = coalesce($8::agent_state, state), last_checkin_at = now()
          where $2::text is not null and id = $2
         returning id
       )
       select ev.* from ev`,
      [
        event.division_id,
        event.agent_id ?? null,
        event.run_id ?? null,
        event.type,
        event.level,
        event.summary,
        json(event.payload),
        agentState,
      ],
    );
    return mapEvent(row!);
  }

  async listEvents(filter: { divisionId?: string; since?: Date; types?: EventType[]; limit?: number } = {}): Promise<EventRow[]> {
    const rows = await this.sql.query<Raw>(
      `select * from events
        where ($1::text is null or division_id = $1)
          and ($2::timestamptz is null or ts >= $2)
          and ($3::text is null or type = any(string_to_array($3, ',')))
        order by ts desc, id desc
        limit $4::int`,
      [filter.divisionId ?? null, filter.since ?? null, filter.types ? list(filter.types) : null, filter.limit ?? 100],
    );
    return rows.map(mapEvent);
  }

  // --------------------------------------------------------------- approvals

  /**
   * Create an approval unless the same agent already has the same action open.
   * Returns the open approval either way.
   */
  async createApproval(input: NewApproval): Promise<{ approval: ApprovalRow; created: boolean }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.sql.query<Raw>(
        `insert into approvals (division_id, agent_id, run_id, tier, title, rationale, action, action_hash,
                                amount_cents, currency, expires_at)
         values ($1, $2, $3::uuid, $4::risk_tier, $5, $6, $7::jsonb, $8, $9::bigint, $10,
                 coalesce($11::timestamptz, now() + interval '72 hours'))
         on conflict (agent_id, action_hash) where status in ('pending', 'approved', 'executing') do nothing
         returning *`,
        [
          input.division_id,
          input.agent_id,
          input.run_id,
          input.tier,
          input.title,
          input.rationale,
          json(input.action),
          input.action_hash,
          input.amount_cents ?? null,
          input.currency ?? null,
          input.expires_at ?? null,
        ],
      );
      if (inserted[0]) return { approval: mapApproval(inserted[0]), created: true };

      const [existing] = await this.sql.query<Raw>(
        `select * from approvals where agent_id = $1 and action_hash = $2
            and status in ('pending', 'approved', 'executing') limit 1`,
        [input.agent_id, input.action_hash],
      );
      if (existing) return { approval: mapApproval(existing), created: false };
      // The open approval closed between the two statements; try the insert again.
    }
    throw new Error(`could not create approval for ${input.agent_id}`);
  }

  async getApproval(id: string): Promise<ApprovalRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from approvals where id = $1::uuid`, [id]);
    return row ? mapApproval(row) : null;
  }

  async listApprovals(filter: { statuses?: ApprovalStatus[]; divisionId?: string; agentId?: string; runId?: string; limit?: number } = {}): Promise<ApprovalRow[]> {
    const rows = await this.sql.query<Raw>(
      `select * from approvals
        where ($1::text is null or status::text = any(string_to_array($1, ',')))
          and ($2::text is null or division_id = $2)
          and ($3::text is null or agent_id = $3)
          and ($4::uuid is null or run_id = $4)
        order by created_at desc
        limit $5::int`,
      [
        filter.statuses ? list(filter.statuses) : null,
        filter.divisionId ?? null,
        filter.agentId ?? null,
        filter.runId ?? null,
        filter.limit ?? 100,
      ],
    );
    return rows.map(mapApproval);
  }

  /**
   * Atomically move an approval from one of `from` to `to`. Returns null when the
   * approval was not in an expected state, which is how a second executor learns
   * that someone else already claimed it.
   */
  async transitionApproval(
    id: string,
    from: readonly ApprovalStatus[],
    to: ApprovalStatus,
    patch: { result?: unknown } = {},
  ): Promise<ApprovalRow | null> {
    const [row] = await this.sql.query<Raw>(
      `update approvals
          set status = $3::approval_status,
              result = case when $4::boolean then $5::jsonb else result end,
              executed_at = case when $3::approval_status in ('executed', 'failed') then now() else executed_at end
        where id = $1::uuid and status::text = any(string_to_array($2, ','))
        returning *`,
      [id, list(from), to, patch.result !== undefined, json(patch.result)],
    );
    return row ? mapApproval(row) : null;
  }

  async countPendingApprovals(agentId: string): Promise<number> {
    const [row] = await this.sql.query<Raw>(`select count(*) as n from approvals where agent_id = $1 and status = 'pending'`, [agentId]);
    return num(row?.n);
  }

  /** Pending approvals past their expiry are marked expired and returned. */
  async expireStaleApprovals(now: Date = new Date()): Promise<ApprovalRow[]> {
    const rows = await this.sql.query<Raw>(
      `update approvals set status = 'expired' where status = 'pending' and expires_at <= $1::timestamptz returning *`,
      [now],
    );
    return rows.map(mapApproval);
  }

  /** Approved approvals that have not been claimed by an executor yet. */
  async listApprovedAwaitingExecution(decidedBefore: Date): Promise<ApprovalRow[]> {
    const rows = await this.sql.query<Raw>(
      `select * from approvals where status = 'approved' and coalesce(decided_at, created_at) <= $1::timestamptz
        order by decided_at limit 50`,
      [decidedBefore],
    );
    return rows.map(mapApproval);
  }

  /**
   * Approvals claimed for execution long ago that never finished (the executor
   * died mid-action) and have not been reported yet.
   */
  async listStuckExecuting(claimedBefore: Date): Promise<ApprovalRow[]> {
    const rows = await this.sql.query<Raw>(
      `select a.* from approvals a
        where a.status = 'executing'
          and coalesce(a.decided_at, a.created_at) <= $1::timestamptz
          and not exists (
            select 1 from events e
             where e.type = 'action.executed'
               and e.payload ->> 'approval_id' = a.id::text
               and e.payload ->> 'outcome' = 'unknown'
          )`,
      [claimedBefore],
    );
    return rows.map(mapApproval);
  }

  // ------------------------------------------------------------------- tasks

  async createTask(input: NewTask): Promise<TaskRow> {
    const [row] = await this.sql.query<Raw>(
      `insert into tasks (division_id, title, notes, owner, status, priority, due_at, source)
       values ($1, $2, $3, coalesce($4, 'nico'), coalesce($5, 'open'), coalesce($6::int, 3), $7::timestamptz, $8)
       returning *`,
      [
        input.division_id,
        input.title,
        input.notes ?? null,
        input.owner ?? null,
        input.status ?? null,
        input.priority ?? null,
        input.due_at ?? null,
        input.source ?? null,
      ],
    );
    return mapTask(row!);
  }

  async updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.notes !== undefined) add("notes", patch.notes);
    if (patch.owner !== undefined) add("owner", patch.owner);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.priority !== undefined) add("priority", patch.priority, "::int");
    if (patch.due_at !== undefined) add("due_at", patch.due_at, "::timestamptz");
    if (sets.length === 0) return this.getTask(id);
    const [row] = await this.sql.query<Raw>(`update tasks set ${sets.join(", ")} where id = $1::uuid returning *`, params);
    return row ? mapTask(row) : null;
  }

  async getTask(id: string): Promise<TaskRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from tasks where id = $1::uuid`, [id]);
    return row ? mapTask(row) : null;
  }

  async listTasks(filter: { statuses?: TaskStatus[]; divisionId?: string; limit?: number } = {}): Promise<TaskRow[]> {
    const rows = await this.sql.query<Raw>(
      `select * from tasks
        where ($1::text is null or status = any(string_to_array($1, ',')))
          and ($2::text is null or division_id = $2)
        order by priority, created_at desc
        limit $3::int`,
      [filter.statuses ? list(filter.statuses) : null, filter.divisionId ?? null, filter.limit ?? 100],
    );
    return rows.map(mapTask);
  }

  // ------------------------------------------------------------------ briefs

  async insertBrief(bodyMd: string, runId: string | null): Promise<BriefRow> {
    const [row] = await this.sql.query<Raw>(`insert into briefs (body_md, run_id) values ($1, $2::uuid) returning *`, [bodyMd, runId]);
    return mapBrief(row!);
  }

  async latestBrief(): Promise<BriefRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from briefs order by created_at desc limit 1`);
    return row ? mapBrief(row) : null;
  }

  // -------------------------------------------------------------- tool calls

  // ------------------------------------------------------------- owner alerts
  // Each claim marks rows notified in one statement, so two alert runs never
  // email the same item. A failed send releases its claims for the next run.

  /** Pending approvals nobody has been emailed about yet, oldest first. */
  async claimUnnotifiedApprovals(limit = 50): Promise<ApprovalRow[]> {
    const rows = await this.sql.query<Raw>(
      `update approvals set notified_at = now()
        where id in (select id from approvals
                      where notified_at is null and status = 'pending'
                      order by created_at limit $1 for update skip locked)
        returning *`,
      [limit],
    );
    return rows.map(mapApproval).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Runs that failed after `since` and were not emailed yet, oldest first. */
  async claimUnnotifiedFailedRuns(since: Date, limit = 50): Promise<RunRow[]> {
    const rows = await this.sql.query<Raw>(
      `update runs set notified_at = now()
        where id in (select id from runs
                      where notified_at is null and status = 'failed' and ended_at >= $1
                      order by ended_at limit $2 for update skip locked)
        returning *`,
      [since, limit],
    );
    return rows.map(mapRun).sort((a, b) => (a.ended_at ?? "").localeCompare(b.ended_at ?? ""));
  }

  /** Briefs published after `since` that were not emailed yet, oldest first. */
  async claimUnnotifiedBriefs(since: Date, limit = 3): Promise<BriefRow[]> {
    const rows = await this.sql.query<Raw>(
      `update briefs set notified_at = now()
        where id in (select id from briefs
                      where notified_at is null and created_at >= $1
                      order by created_at limit $2 for update skip locked)
        returning *`,
      [since, limit],
    );
    return rows.map(mapBrief).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Undo claims after a failed send, so the next alert run includes those items again. */
  async releaseNotificationClaims(ids: { approvals?: string[]; runs?: string[]; briefs?: string[] }): Promise<void> {
    if (ids.approvals?.length) await this.sql.query(`update approvals set notified_at = null where id = any($1::uuid[])`, [ids.approvals]);
    if (ids.runs?.length) await this.sql.query(`update runs set notified_at = null where id = any($1::uuid[])`, [ids.runs]);
    if (ids.briefs?.length) await this.sql.query(`update briefs set notified_at = null where id = any($1::uuid[])`, [ids.briefs]);
  }

  async recordNotification(input: Omit<NotificationRow, "id" | "created_at" | "channel">): Promise<NotificationRow> {
    const [row] = await this.sql.query<Raw>(
      `insert into notifications (kind, subject, item_count, status, provider_message_id, error)
       values ($1, left($2, 200), $3, $4, $5, $6) returning *`,
      [input.kind, input.subject, input.item_count, input.status, input.provider_message_id, input.error],
    );
    return mapNotification(row!);
  }

  async lastNotification(): Promise<NotificationRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from notifications order by created_at desc limit 1`);
    return row ? mapNotification(row) : null;
  }

  async logToolCall(entry: ToolCallLog): Promise<void> {
    await this.sql.query(
      `insert into tool_calls (run_id, agent_id, tool_name, tier, status, args, result, duration_ms)
       values ($1::uuid, $2, $3, $4::risk_tier, $5, $6::jsonb, $7::jsonb, $8::int)`,
      [
        entry.run_id,
        entry.agent_id,
        entry.tool_name,
        entry.tier,
        entry.status,
        json(entry.args),
        json(entry.result),
        entry.duration_ms ?? null,
      ],
    );
  }

  async countToolCalls(runId: string): Promise<number> {
    const [row] = await this.sql.query<Raw>(`select count(*) as n from tool_calls where run_id = $1::uuid`, [runId]);
    return num(row?.n);
  }

  // ------------------------------------------------------------------ drafts

  async createDraft(input: NewDraft): Promise<DraftRow> {
    const [row] = await this.sql.query<Raw>(
      `insert into drafts (division_id, agent_id, run_id, kind, channel, title, body_md)
       values ($1, $2, $3::uuid, $4, $5, $6, $7) returning *`,
      [input.division_id, input.agent_id, input.run_id, input.kind, input.channel, input.title, input.body_md],
    );
    return mapDocument(row!);
  }

  async listDrafts(filter: { divisionId?: string; agentId?: string; runId?: string; since?: Date; limit?: number } = {}): Promise<DraftRow[]> {
    const rows = await this.sql.query<Raw>(
      `select * from drafts
        where ($1::text is null or division_id = $1)
          and ($2::text is null or agent_id = $2)
          and ($3::uuid is null or run_id = $3)
          and ($4::timestamptz is null or created_at >= $4)
        order by created_at desc
        limit $5::int`,
      [filter.divisionId ?? null, filter.agentId ?? null, filter.runId ?? null, filter.since ?? null, filter.limit ?? 50],
    );
    return rows.map(mapDocument);
  }

  // ------------------------------------------------------------ email drafts

  async createEmailDraft(input: Omit<EmailDraftRow, "id" | "created_at" | "status">): Promise<EmailDraftRow> {
    const [row] = await this.sql.query<Raw>(
      `insert into email_drafts (division_id, agent_id, run_id, to_addr, subject, body_text, thread_id, in_reply_to)
       values ($1, $2, $3::uuid, $4, $5, $6, $7, $8) returning *`,
      [input.division_id, input.agent_id, input.run_id, input.to_addr, input.subject, input.body_text, input.thread_id, input.in_reply_to],
    );
    return mapDraft(row!);
  }

  async getEmailDraft(id: string): Promise<EmailDraftRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from email_drafts where id = $1::uuid`, [id]);
    return row ? mapDraft(row) : null;
  }

  async setEmailDraftStatus(id: string, status: EmailDraftRow["status"]): Promise<void> {
    await this.sql.query(`update email_drafts set status = $2 where id = $1::uuid`, [id, status]);
  }

  // ----------------------------------------------------------------- pricing

  async getModelPricing(model: string): Promise<ModelPricingRow | null> {
    const [row] = await this.sql.query<Raw>(`select * from model_pricing where model = $1`, [model]);
    return row ? mapPricing(row) : null;
  }

  async upsertModelPricing(p: ModelPricingRow): Promise<void> {
    await this.sql.query(
      `insert into model_pricing (model, input_per_mtok, output_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok,
                                  cache_read_per_mtok, long_context_threshold, long_input_per_mtok, long_output_per_mtok, updated_at)
       values ($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::int, $8::numeric, $9::numeric, now())
       on conflict (model) do update set
         input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok,
         cache_write_5m_per_mtok = excluded.cache_write_5m_per_mtok, cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
         cache_read_per_mtok = excluded.cache_read_per_mtok, long_context_threshold = excluded.long_context_threshold,
         long_input_per_mtok = excluded.long_input_per_mtok, long_output_per_mtok = excluded.long_output_per_mtok,
         updated_at = now()`,
      [
        p.model,
        p.input_per_mtok,
        p.output_per_mtok,
        p.cache_write_5m_per_mtok,
        p.cache_write_1h_per_mtok,
        p.cache_read_per_mtok,
        p.long_context_threshold,
        p.long_input_per_mtok,
        p.long_output_per_mtok,
      ],
    );
  }

  // ----------------------------------------------------------------- secrets

  /** Reads 'agent:<agentId>:<integration>' from Supabase Vault. */
  async getAgentSecret(agentId: string, integration: string): Promise<string | null> {
    const [row] = await this.sql.query<Raw>(`select public.agent_secret($1, $2) as secret`, [agentId, integration]);
    const secret = row?.secret;
    return typeof secret === "string" && secret.length > 0 ? secret : null;
  }
}
