-- Event receipts are plumbing for ingest_app_event(), which runs as its owner.
-- Nobody reads or writes them through the API; say so explicitly.
create policy no_access on app_event_receipts for all to anon, authenticated using (false) with check (false);
