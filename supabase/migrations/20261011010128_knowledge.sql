-- Knowledge store (Phase 0): versioned documents per division that agents
-- search during a run (strategy, rules, decisions, lessons).
--
-- Nico writes and edits documents in the city; agents read them through the
-- knowledge.search / knowledge.get tools, scoped to their own division (HQ
-- reads every division). Agents may save notes of their own but never change
-- a document Nico last edited. Every change keeps the previous version.

-- array_to_string is only STABLE (element output can depend on settings); for text[] it
-- cannot, so this wrapper may be IMMUTABLE and used in the generated search column.
create function public.tags_text(tags text[]) returns text
language sql immutable parallel safe set search_path = '' as $$ select array_to_string(tags, ' ') $$;

create table documents (
  id          uuid primary key default gen_random_uuid(),
  division_id text references divisions(id) not null,
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  title       text not null check (char_length(title) between 1 and 200),
  body_md     text not null check (char_length(body_md) between 1 and 100000),
  tags        text[] not null default '{}' check (cardinality(tags) <= 20),
  archived    boolean not null default false,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 'owner' when Nico wrote it in the city, else the agent id that saved it.
  updated_by  text not null default 'owner',
  search      tsvector generated always as (
                setweight(to_tsvector('english', title), 'A') ||
                setweight(to_tsvector('english', public.tags_text(tags)), 'B') ||
                setweight(to_tsvector('english', body_md), 'C')) stored,
  unique (division_id, slug)
);
create index documents_search_idx on documents using gin (search);
create index documents_division_idx on documents (division_id, updated_at desc);

create table document_versions (
  id          bigint generated always as identity primary key,
  document_id uuid references documents(id) on delete cascade not null,
  version     int not null,
  title       text not null,
  body_md     text not null,
  tags        text[] not null,
  updated_by  text not null,
  saved_at    timestamptz not null default now(),
  unique (document_id, version)
);
create index document_versions_document_idx on document_versions (document_id, version desc);

-- Stamp authorship from the session, keep the previous version, bump the number.
-- Security definer so an edit from the browser can write the version history,
-- which the browser itself cannot touch; it only ever runs as this trigger.
create function public.stamp_document() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null then
    new.updated_by := 'owner';  -- the browser cannot claim to be an agent
  end if;
  if tg_op = 'UPDATE' then
    if new.title is distinct from old.title or new.body_md is distinct from old.body_md or new.tags is distinct from old.tags then
      insert into public.document_versions (document_id, version, title, body_md, tags, updated_by, saved_at)
      values (old.id, old.version, old.title, old.body_md, old.tags, old.updated_by, old.updated_at);
      new.version := old.version + 1;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

revoke all on function public.stamp_document() from public, anon, authenticated;

create trigger documents_stamp
  before insert or update on documents
  for each row execute function public.stamp_document();

alter table documents enable row level security;
alter table document_versions enable row level security;
revoke all on documents, document_versions from anon, authenticated;

grant select on documents, document_versions to authenticated;
create policy owner_read on documents for select to authenticated using ((select public.is_owner()));
create policy owner_read on document_versions for select to authenticated using ((select public.is_owner()));

-- Nico creates and edits documents in the city (no deletes: archive instead).
grant insert (division_id, slug, title, body_md, tags) on documents to authenticated;
grant update (title, body_md, tags, archived) on documents to authenticated;
create policy owner_write on documents for insert to authenticated with check ((select public.is_owner()));
create policy owner_edit on documents for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

alter publication supabase_realtime add table documents;
