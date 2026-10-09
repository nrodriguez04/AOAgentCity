-- supabase/migrations/0003_approval_decisions.sql
--
-- What happens when Nico approves or rejects in the city (spec §7.3):
--   1. decided_at is stamped server-side.
--   2. An approval.decided event is written so the city's beacon and activity log
--      update for rejections too (rejections never reach the worker).
--   3. The agent leaves waiting_approval once nothing else is pending.
--   4. On approve, the execute-approval Trigger.dev task is triggered through
--      pg_net with idempotency key = approval id. If pg_net or the secret is not
--      configured, the sweep-approvals task (every minute) picks it up instead.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create function public.stamp_approval_decision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    new.decided_at := now();
  end if;
  return new;
end $$;

create trigger approvals_stamp_decision
  before update of status on approvals
  for each row execute function public.stamp_approval_decision();

-- Trigger.dev secret key for dispatch, stored in Vault as 'trigger_secret_key'.
create function public.dispatch_approval(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if to_regnamespace('net') is null then
    return;
  end if;

  select trigger_api_url into v_url from public.settings where id;
  begin
    select s.decrypted_secret into v_key
      from vault.decrypted_secrets s
     where s.name = 'trigger_secret_key'
     limit 1;
  exception when others then
    v_key := null;
  end;
  if v_url is null or v_key is null then
    return;
  end if;

  perform net.http_post(
    url := rtrim(v_url, '/') || '/api/v1/tasks/execute-approval/trigger',
    body := jsonb_build_object(
      'payload', jsonb_build_object('approvalId', p_approval_id),
      'options', jsonb_build_object(
        'payloadType', 'application/json',
        'idempotencyKey', 'approval:' || p_approval_id::text
      )
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    )
  );
end $$;
revoke all on function public.dispatch_approval(uuid) from public, anon, authenticated;

create function public.on_approval_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status <> 'pending' or new.status not in ('approved', 'rejected') then
    return new;
  end if;

  insert into public.events (division_id, agent_id, run_id, type, level, summary, payload)
  values (
    new.division_id,
    new.agent_id,
    new.run_id,
    'approval.decided',
    (case when new.status = 'approved' then 'success' else 'info' end)::public.event_level,
    left((case when new.status = 'approved' then 'Approved: ' else 'Rejected: ' end) || new.title, 200),
    jsonb_build_object('approval_id', new.id, 'status', new.status, 'note', new.decided_note)
  );

  update public.agents a
     set state = 'idle'
   where a.id = new.agent_id
     and a.state = 'waiting_approval'
     and not exists (
       select 1 from public.approvals p
        where p.agent_id = a.id and p.status = 'pending' and p.id <> new.id
     );

  if new.status = 'approved' then
    perform public.dispatch_approval(new.id);
  end if;
  return new;
end $$;

create trigger approvals_decided
  after update of status on approvals
  for each row execute function public.on_approval_decided();
