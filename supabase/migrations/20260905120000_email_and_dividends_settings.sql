-- Email control (all opt-in, one master switch) + dividends refresh cadence.
-- email_master_enabled: kill switch for every outbound email.
-- notify_listings: new-listing / delisting heads-up (opt-in, default off).
-- notify_failures: ops "ingestion is failing" alert (default ON so silent staleness can't happen).
-- dividends_update_freq / last_dividends_update_at: the dividends scrape runs on its own cadence,
--   bundled inside the ingest run (best-effort; no fail-streak escalation — staleness shows in-app).
alter table app_settings add column email_master_enabled  boolean not null default true;
alter table app_settings add column notify_listings        boolean not null default false;
alter table app_settings add column notify_failures        boolean not null default true;
alter table app_settings add column dividends_update_freq  text not null default 'weekly'
  check (dividends_update_freq in ('daily', 'weekly', 'monthly', 'never'));
alter table app_settings add column last_dividends_update_at timestamptz;
