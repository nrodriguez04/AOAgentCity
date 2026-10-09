-- supabase/migrations/0002_security.sql
--
-- Row-level security (spec §5.3).
--   * The city authenticates as Nico through Supabase Auth. Only users listed in
--     `owners` can read anything.
--   * From the browser, the owner can read the city's tables and can write exactly
--     two things: an approval decision (status + note on a pending approval) and the
--     pause switch. Everything else is written by the worker.
--   * The worker connects with a server-side database URL (never shipped to the
--     browser) and is not subject to these policies.

create table owners (
  user_id    uuid primary key,               -- auth.users.id
  note       text,
  created_at timestamptz not null default now()
);

create function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.owners o where o.user_id = (select auth.uid()));
$$;
revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

alter table divisions         enable row level security;
alter table agents            enable row level security;
alter table agent_permissions enable row level security;
alter table runs              enable row level security;
alter table events            enable row level security;
alter table approvals         enable row level security;
alter table tasks             enable row level security;
alter table briefs            enable row level security;
alter table settings          enable row level security;
alter table model_pricing     enable row level security;
alter table tool_calls        enable row level security;
alter table email_drafts      enable row level security;
alter table owners            enable row level security; -- no policies: invisible to the browser

-- Supabase grants table privileges to anon/authenticated by default. Start from
-- nothing and grant back only what the city needs.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on divisions, agents, agent_permissions, runs, events, approvals,
                tasks, briefs, settings, model_pricing, tool_calls, email_drafts
  to authenticated;

-- Column-level grants: the only writable columns from the browser.
grant update (status, decided_note) on approvals to authenticated;
grant update (agents_paused) on settings to authenticated;

create policy owner_read on divisions         for select to authenticated using ((select public.is_owner()));
create policy owner_read on agents            for select to authenticated using ((select public.is_owner()));
create policy owner_read on agent_permissions for select to authenticated using ((select public.is_owner()));
create policy owner_read on runs              for select to authenticated using ((select public.is_owner()));
create policy owner_read on events            for select to authenticated using ((select public.is_owner()));
create policy owner_read on approvals         for select to authenticated using ((select public.is_owner()));
create policy owner_read on tasks             for select to authenticated using ((select public.is_owner()));
create policy owner_read on briefs            for select to authenticated using ((select public.is_owner()));
create policy owner_read on settings          for select to authenticated using ((select public.is_owner()));
create policy owner_read on model_pricing     for select to authenticated using ((select public.is_owner()));
create policy owner_read on tool_calls        for select to authenticated using ((select public.is_owner()));
create policy owner_read on email_drafts      for select to authenticated using ((select public.is_owner()));

-- Decide a pending, unexpired approval. decided_at is stamped by a trigger
-- (0003) rather than trusted from the browser.
create policy owner_decides_pending on approvals for update to authenticated
  using ((select public.is_owner()) and status = 'pending' and expires_at > now())
  with check ((select public.is_owner()) and status in ('approved', 'rejected'));

create policy owner_toggles_pause on settings for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- Scoped credentials (spec §7.4) live in Supabase Vault, one secret per
-- (agent, integration), named 'agent:<agent_id>:<integration>'. Only the worker's
-- database role can call this.
create function public.agent_secret(p_agent_id text, p_integration text) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret
    from vault.decrypted_secrets s
   where s.name = 'agent:' || p_agent_id || ':' || p_integration
   limit 1;
$$;
revoke all on function public.agent_secret(text, text) from public, anon, authenticated;
