-- Real progress counts for the manual updater row (not fabricated): each Edge
-- Function writes {done, total} here as it works through MSX's market batches,
-- and the frontend polls get_settings while a run is in flight. Cleared (null)
-- when idle, so a page reload never shows stale progress from a past run.
alter table app_settings add column price_ingest_progress jsonb;
alter table app_settings add column company_refresh_progress jsonb;
