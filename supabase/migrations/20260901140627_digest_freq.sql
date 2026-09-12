-- User-configurable digest email cadence, independent of the price/company
-- update schedule — digest.ts checks this itself since it's chained off
-- ingest.ts, which may run more often than the user wants the email.
alter table app_settings add column digest_freq text not null default 'daily';
alter table app_settings add column last_digest_sent_at timestamptz;
