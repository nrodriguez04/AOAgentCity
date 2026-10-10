-- supabase/migrations/20261010010839_init.sql
--
-- Agent City schema (spec §5.1). Additions to the spec are marked "addition".

create type division_status as enum ('concept','planned','planning','live','paused');
create type agent_state     as enum ('idle','working','waiting_approval','error','disabled');
create type run_status      as enum ('queued','running','waiting_approval','succeeded','failed','cancelled');
create type risk_tier       as enum ('read','internal_write','external_effect','financial');
-- addition: 'executing' is the claimed state between approved and executed/failed.
-- Claiming it with a conditional update is what makes execution happen once.
create type approval_status as enum ('pending','approved','executing','rejected','expired','executed','failed');
create type event_level     as enum ('info','success','warning','error');

create table divisions (
  id            text primary key,              -- 'hq', 'parlaylab', 'halo' ...
  name          text not null,
  kind          text not null check (kind in ('hq','business','personal','creator')),
  status        division_status not null default 'planned',
  summary       text,
  context_md    text,                          -- living context doc agents read
  city_slot     jsonb,                         -- {x, z, buildingModel}
  metrics       jsonb not null default '{}'::jsonb, -- addition: latest metric.updated values
  created_at    timestamptz not null default now()
);

create table agents (
  id              text primary key,            -- 'parlaylab.billing-01'
  division_id     text references divisions(id) not null,
  display_name    text not null,               -- 'BILLING-01'
  role            text not null,               -- 'Subscription operations'
  model_tier      text not null default 'standard' check (model_tier in ('reasoning','standard','fast')),
  instructions    text not null,               -- system prompt
  default_goal    text,                        -- addition: goal used by scheduled runs
  schedule_cron   text,                        -- null = on-demand only
  state           agent_state not null default 'idle',
  last_checkin_at timestamptz,
  daily_budget_usd numeric(10,2) not null default 2.00,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Least-privilege: which tools an agent may call, and at what tier.
create table agent_permissions (
  agent_id   text references agents(id) on delete cascade,
  tool_name  text not null,                    -- 'stripe.list_subscriptions'
  max_tier   risk_tier not null,
  primary key (agent_id, tool_name)
);

create table runs (
  id            uuid primary key default gen_random_uuid(),
  agent_id      text references agents(id) not null,
  trigger       text not null check (trigger in ('cron','hq','manual','approval')),
  goal          text,
  status        run_status not null default 'queued',
  model         text,                          -- addition: model that served the run
  created_at    timestamptz not null default now(), -- addition
  started_at    timestamptz,
  ended_at      timestamptz,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens  int not null default 0,  -- addition
  cache_write_tokens int not null default 0,  -- addition
  cost_usd      numeric(10,4) not null default 0,
  error         text,
  transcript    jsonb                          -- full message history for audit
);
create index runs_agent_started_idx on runs (agent_id, started_at desc);
create index runs_open_idx on runs (status) where status in ('queued','running','waiting_approval');

create table events (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  division_id text references divisions(id) not null,
  agent_id    text references agents(id),
  run_id      uuid references runs(id),
  -- addition: the event contract (packages/core/src/events.ts) enforced in the database too
  type        text not null check (type in (
                'run.started','run.progress','run.succeeded','run.failed',
                'approval.requested','approval.decided','action.executed',
                'metric.updated','task.created','task.updated','brief.published')),
  level       event_level not null default 'info',
  summary     text not null check (char_length(summary) between 1 and 200),
  payload     jsonb not null default '{}'::jsonb
);
create index events_division_ts_idx on events (division_id, ts desc);
create index events_ts_idx on events (ts desc);

create table approvals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  division_id   text references divisions(id) not null,
  agent_id      text references agents(id) not null,
  run_id        uuid references runs(id),
  tier          risk_tier not null check (tier in ('external_effect','financial')),
  title         text not null,                 -- 'Refund $19 to user X'
  rationale     text not null,                 -- agent's explanation
  action        jsonb not null,                -- {tool, args} executed verbatim on approve
  action_hash   text not null,                 -- addition: sha256 of action, for dedupe
  amount_cents  bigint,                        -- addition: shown for financial actions
  currency      text,                          -- addition
  status        approval_status not null default 'pending',
  decided_at    timestamptz,
  decided_note  text,
  expires_at    timestamptz not null default now() + interval '72 hours',
  executed_at   timestamptz,                   -- addition
  result        jsonb
);
-- addition: an agent cannot queue the same action twice while one is still open
-- (a 5pm run re-proposing the 8am refund gets the existing approval back).
create unique index approvals_open_action_uidx on approvals (agent_id, action_hash)
  where status in ('pending','approved','executing');
create index approvals_status_idx on approvals (status, created_at desc);

create table tasks (
  id          uuid primary key default gen_random_uuid(),
  division_id text references divisions(id) not null,
  title       text not null,
  notes       text,                            -- addition
  owner       text not null default 'nico',    -- 'nico' or an agent id
  status      text not null default 'open' check (status in ('open','in_progress','blocked','done','parked','killed')),
  priority    int not null default 3 check (priority between 1 and 5), -- 1 = highest
  due_at      timestamptz,
  source      text,                            -- 'hq' | 'manual' | agent id
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tasks_open_idx on tasks (division_id, priority) where status in ('open','in_progress','blocked');

create table briefs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  body_md     text not null,
  run_id      uuid references runs(id)
);

-- addition: global settings. agents_paused is the "Pause city" kill switch (spec §8).
create table settings (
  id              boolean primary key default true check (id),
  agents_paused   boolean not null default false,
  trigger_api_url text not null default 'https://api.trigger.dev',
  updated_at      timestamptz not null default now()
);
insert into settings (id) values (true);

-- addition: per-model pricing for cost tracking (spec §9), USD per million tokens.
create table model_pricing (
  model                    text primary key,
  input_per_mtok           numeric(10,4) not null,
  output_per_mtok          numeric(10,4) not null,
  cache_write_5m_per_mtok  numeric(10,4) not null,
  cache_write_1h_per_mtok  numeric(10,4) not null,
  cache_read_per_mtok      numeric(10,4) not null,
  long_context_threshold   int,
  long_input_per_mtok      numeric(10,4),
  long_output_per_mtok     numeric(10,4),
  updated_at               timestamptz not null default now()
);

-- addition: every tool call with its args and result (security checklist, spec §13).
create table tool_calls (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  run_id      uuid references runs(id),
  agent_id    text references agents(id) not null,
  tool_name   text not null,
  tier        risk_tier,
  status      text not null check (status in ('ok','error','denied','invalid','pending_approval')),
  args        jsonb,
  result      jsonb,
  duration_ms int
);
create index tool_calls_run_idx on tool_calls (run_id, ts);

-- addition: drafts written by email.draft (internal_write). Sending is a separate,
-- approval-gated action that carries the full message verbatim.
create table email_drafts (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  division_id text references divisions(id) not null,
  agent_id    text references agents(id) not null,
  run_id      uuid references runs(id),
  to_addr     text not null,
  subject     text not null,
  body_text   text not null,
  thread_id   text,
  in_reply_to text,
  status      text not null default 'draft' check (status in ('draft','queued','sent','discarded'))
);

create function set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_updated_at();
create trigger settings_set_updated_at before update on settings
  for each row execute function set_updated_at();

-- Enable realtime on what the city renders (spec §5.1, plus briefs and settings
-- for the brief view and the pause switch).
alter publication supabase_realtime add table agents, events, approvals, divisions, tasks, briefs, settings;
