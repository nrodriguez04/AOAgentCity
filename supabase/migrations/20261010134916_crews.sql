-- Crews (CrewAI) work alongside the Claude agents. A crew is an `agents` row
-- with runtime 'crewai': it has a division, schedule, budget and tool grants and
-- records runs like any agent, but its reasoning happens on CrewAI AMP and Agent
-- City applies its structured result through the tool gateway.
alter table agents add column runtime text not null default 'claude'
  check (runtime in ('claude', 'crewai'));

-- Documents agents and crews write for Nico to review: devlogs, social posts,
-- reports and plans. Publishing any of them is a separate, approval-gated action.
create table drafts (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  division_id text references divisions(id) not null,
  agent_id    text references agents(id) not null,
  run_id      uuid references runs(id),
  kind        text not null check (kind in ('devlog', 'social_post', 'article', 'newsletter', 'report', 'plan', 'other')),
  channel     text check (char_length(channel) between 1 and 40), -- 'blog', 'x', 'bluesky', 'reddit', ...
  title       text not null check (char_length(title) between 1 and 200),
  body_md     text not null check (char_length(body_md) between 1 and 40000),
  status      text not null default 'draft' check (status in ('draft', 'approved', 'published', 'discarded'))
);
create index drafts_division_created_idx on drafts (division_id, created_at desc);
create index drafts_agent_idx on drafts (agent_id);
create index drafts_run_idx on drafts (run_id);

-- Same rules as the other tables: the owner reads, only the worker writes.
-- Supabase grants new tables to anon and authenticated, so start from nothing.
alter table drafts enable row level security;
revoke all on drafts from anon, authenticated;
grant select on drafts to authenticated;
create policy owner_read on drafts for select to authenticated using ((select public.is_owner()));

alter publication supabase_realtime add table drafts;
