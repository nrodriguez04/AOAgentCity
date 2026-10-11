-- Company connector, inbound half (Phase 0): company apps (FedOps, Hålo,
-- ParlayLab, GalleySwap) push signed events into the event store, and
-- approvals that live in an app are mirrored here, read-only.
--
-- Each app signs every request with its own secret, kept in Vault as
-- app:<app>:events: signature = "sha256=" || hex(hmac_sha256(secret, timestamp || "." || body)).
-- The database verifies it (the secret never leaves Vault), rejects stale
-- timestamps and duplicate event ids, and accepts only event types in the
-- app's own namespace. Only the service role may call ingest_app_event; the
-- app-events Edge Function forwards to it, so the publishable key alone
-- cannot reach it. The app stays the authority for its own approvals:
-- Agent City shows them and links to the app, it never decides them.

create extension if not exists pgcrypto with schema extensions;

-- App events are namespaced: <app>.<subject>.<verb>, e.g. fedops.opportunity.qualified.
alter table events drop constraint events_type_check;
alter table events add constraint events_type_check check (
  type in ('run.started','run.progress','run.succeeded','run.failed',
           'approval.requested','approval.decided','action.executed',
           'metric.updated','task.created','task.updated','brief.published')
  or type ~ '^(fedops|halo|parlaylab|galleyswap)(\.[a-z][a-z0-9_]*){2,3}$'
);

create table app_event_receipts (
  app         text not null,
  external_id text not null,
  received_at timestamptz not null default now(),
  event_id    bigint references events(id),
  primary key (app, external_id)
);
create index app_event_receipts_event_idx on app_event_receipts (event_id);

create table app_approvals (
  app          text not null check (app in ('fedops', 'halo', 'parlaylab', 'galleyswap')),
  external_id  text not null check (char_length(external_id) between 1 and 200),
  division_id  text references divisions(id) not null,
  title        text not null check (char_length(title) between 1 and 200),
  -- external_effect ~ FedOps YELLOW (leaves the building); binding ~ RED (legal or financial liability).
  risk         text not null check (risk in ('external_effect', 'financial', 'binding')),
  url          text check (url is null or url ~ '^https://[^\s]+$'),
  status       text not null check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  requested_at timestamptz not null,
  expires_at   timestamptz,
  decided_at   timestamptz,
  updated_at   timestamptz not null default now(),
  notified_at  timestamptz,
  primary key (app, external_id)
);
create index app_approvals_pending_idx on app_approvals (requested_at) where status = 'pending';
create index app_approvals_division_idx on app_approvals (division_id);

alter table app_event_receipts enable row level security;
alter table app_approvals enable row level security;
revoke all on app_event_receipts, app_approvals from anon, authenticated;
grant select on app_approvals to authenticated;
create policy owner_read on app_approvals for select to authenticated using ((select public.is_owner()));
alter publication supabase_realtime add table app_approvals;

create function public.ingest_app_event(p_app text, p_timestamp bigint, p_signature text, p_body text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_secret   text;
  v_body     jsonb;
  v_id       text;
  v_type     text;
  v_summary  text;
  v_level    public.event_level;
  v_payload  jsonb;
  v_event_id bigint;
  v_approval jsonb;
begin
  if p_app is null or p_app not in ('fedops', 'halo', 'parlaylab', 'galleyswap') then
    raise exception 'unknown app' using errcode = '22023';
  end if;
  if p_timestamp is null or abs(extract(epoch from now()) - p_timestamp) > 300 then
    raise exception 'timestamp is more than 5 minutes off' using errcode = '22023';
  end if;
  if p_body is null or octet_length(p_body) > 65536 then
    raise exception 'body missing or over 64 KB' using errcode = '22023';
  end if;

  -- One answer for "not connected" and "wrong signature", so a caller learns nothing.
  -- Digests are compared rather than the strings, so timing reveals nothing either.
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = 'app:' || p_app || ':events' limit 1;
  if v_secret is null or extensions.digest(coalesce(p_signature, ''), 'sha256') <> extensions.digest(
       'sha256=' || encode(extensions.hmac(convert_to(p_timestamp::text || '.' || p_body, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'), 'hex'),
       'sha256') then
    raise exception 'signature rejected' using errcode = '28000';
  end if;

  begin
    v_body := p_body::jsonb;
  exception when others then
    raise exception 'body is not JSON' using errcode = '22023';
  end;
  v_id := v_body ->> 'id';
  v_type := v_body ->> 'type';
  v_summary := v_body ->> 'summary';
  v_payload := coalesce(v_body -> 'payload', '{}'::jsonb);
  if v_id is null or char_length(v_id) not between 1 and 200 then
    raise exception 'id is required (1 to 200 characters)' using errcode = '22023';
  end if;
  if v_type is null or v_type !~ ('^' || p_app || '(\.[a-z][a-z0-9_]*){2,3}$') then
    raise exception 'type must be in the app''s namespace, e.g. %.opportunity.qualified', p_app using errcode = '22023';
  end if;
  if v_summary is null or char_length(v_summary) not between 1 and 200 then
    raise exception 'summary is required (1 to 200 characters)' using errcode = '22023';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload must be an object' using errcode = '22023';
  end if;
  begin
    v_level := coalesce(v_body ->> 'level', 'info')::public.event_level;
  exception when others then
    raise exception 'level must be info, success, warning or error' using errcode = '22023';
  end;

  insert into public.app_event_receipts (app, external_id) values (p_app, v_id) on conflict do nothing;
  if not found then
    return jsonb_build_object('status', 'duplicate');
  end if;

  insert into public.events (division_id, type, level, summary, payload)
  values (p_app, v_type, v_level, v_summary,
          v_payload || jsonb_strip_nulls(jsonb_build_object('app', p_app, 'external_id', v_id, 'occurred_at', v_body -> 'occurred_at')))
  returning id into v_event_id;
  update public.app_event_receipts set event_id = v_event_id where app = p_app and external_id = v_id;

  v_approval := v_body -> 'approval';
  if v_approval is not null and jsonb_typeof(v_approval) <> 'null' then
    if jsonb_typeof(v_approval) <> 'object' then
      raise exception 'approval must be an object' using errcode = '22023';
    end if;
    -- The table's checks name the offending field (id, title, risk, url, status) if anything else is off.
    insert into public.app_approvals as a (app, external_id, division_id, title, risk, url, status, requested_at, expires_at, decided_at)
    values (p_app, v_approval ->> 'id', p_app, left(v_approval ->> 'title', 200), v_approval ->> 'risk', v_approval ->> 'url',
            v_approval ->> 'status', coalesce((v_approval ->> 'requested_at')::timestamptz, now()),
            (v_approval ->> 'expires_at')::timestamptz, (v_approval ->> 'decided_at')::timestamptz)
    on conflict (app, external_id) do update
      set title = excluded.title, risk = excluded.risk, url = excluded.url, status = excluded.status,
          expires_at = excluded.expires_at, decided_at = excluded.decided_at, updated_at = now(),
          -- A decision clears the alert claim so a reopened approval can alert again.
          notified_at = case when excluded.status = 'pending' then a.notified_at else null end;
  end if;

  return jsonb_build_object('status', 'accepted', 'event_id', v_event_id);
end $$;

revoke all on function public.ingest_app_event(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.ingest_app_event(text, bigint, text, text) to service_role;
