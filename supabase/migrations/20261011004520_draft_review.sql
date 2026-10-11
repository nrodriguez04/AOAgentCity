-- Draft review (Phase 0): Nico approves, edits, discards or marks published
-- the drafts that agents and crews write, from the city.
--
-- The browser may change only status, title, body_md and published_url, and
-- only as an owner. A trigger stamps who reviewed it and when, and keeps the
-- agent's original text the first time the body is edited, so every edit is
-- recorded as feedback on what the agent wrote. Publishing itself stays
-- manual: "published" records that Nico posted it, and where.

alter table drafts
  add column updated_at       timestamptz not null default now(),
  add column reviewed_at      timestamptz,
  add column reviewed_by      uuid,          -- auth.users.id of the owner who reviewed it
  add column original_body_md text,          -- the agent's text, kept when the body is first edited
  add column published_url    text check (published_url is null or published_url ~ '^https?://[^\s]+$');

alter table drafts add constraint drafts_published_url_length check (published_url is null or char_length(published_url) <= 2000);

grant update (status, title, body_md, published_url) on drafts to authenticated;
create policy owner_review on drafts for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

create function public.stamp_draft_review() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.body_md is distinct from old.body_md and old.original_body_md is null then
    new.original_body_md := old.body_md;
  end if;
  if new.status is distinct from old.status
     or new.title is distinct from old.title
     or new.body_md is distinct from old.body_md
     or new.published_url is distinct from old.published_url then
    new.reviewed_at := now();
    new.reviewed_by := (select auth.uid());
  end if;
  return new;
end $$;

create trigger drafts_stamp_review
  before update on drafts
  for each row execute function public.stamp_draft_review();
