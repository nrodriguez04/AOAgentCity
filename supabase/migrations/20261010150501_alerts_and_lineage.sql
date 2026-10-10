-- Owner alerts, run lineage and approval attribution (Phase 0).
--
-- 1. Owner alerts: the worker emails Nico new pending approvals, failed runs and
--    HQ's brief. notified_at marks what was already sent; the notifications
--    table logs each email (no recipient address is stored).
-- 2. Run lineage: parent_run_id links an HQ-dispatched run to the HQ run that
--    dispatched it; correlation_id is shared by every run in that chain.
-- 3. decided_by: which signed-in user decided an approval, stamped by the
--    existing decision trigger from the session, never sent by the browser.

-- 1. Owner alerts ------------------------------------------------------------
alter table approvals add column notified_at timestamptz;
alter table runs      add column notified_at timestamptz;
alter table briefs    add column notified_at timestamptz;

create index approvals_unnotified_idx on approvals (created_at) where notified_at is null and status = 'pending';
create index runs_unnotified_failed_idx on runs (ended_at) where notified_at is null and status = 'failed';
create index briefs_unnotified_idx on briefs (created_at) where notified_at is null;

create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  kind                text not null check (kind in ('digest', 'brief')),
  channel             text not null default 'email' check (channel in ('email')),
  subject             text not null check (char_length(subject) between 1 and 200),
  item_count          int  not null default 0 check (item_count >= 0),
  status              text not null check (status in ('sent', 'failed')),
  provider_message_id text,
  error               text
);
create index notifications_created_idx on notifications (created_at desc);

alter table notifications enable row level security;
revoke all on notifications from anon, authenticated;
grant select on notifications to authenticated;
create policy owner_read on notifications for select to authenticated using ((select public.is_owner()));

-- 2. Run lineage --------------------------------------------------------------
alter table runs add column parent_run_id  uuid references runs(id);
alter table runs add column correlation_id uuid;
create index runs_parent_idx on runs (parent_run_id) where parent_run_id is not null;
create index runs_correlation_idx on runs (correlation_id);

-- 3. Who decided an approval ------------------------------------------------------
alter table approvals add column decided_by uuid;  -- auth.users.id of the owner who decided

create or replace function public.stamp_approval_decision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    new.decided_at := now();
    new.decided_by := (select auth.uid());
  end if;
  return new;
end $$;
