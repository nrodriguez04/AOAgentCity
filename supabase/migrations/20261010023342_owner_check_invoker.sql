-- The owner check no longer needs SECURITY DEFINER. A signed-in user may read
-- their own `owners` row and nothing else, so is_owner() can run with the
-- caller's rights (Supabase advisor lints 0008 and 0029). Writing to `owners`
-- still needs the database owner: nobody can make themselves an owner from the
-- browser.

create policy owner_reads_self on owners for select to authenticated
  using (user_id = (select auth.uid()));
grant select on owners to authenticated;

create or replace function public.is_owner() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.owners o where o.user_id = (select auth.uid()));
$$;
