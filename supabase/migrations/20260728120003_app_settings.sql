-- Phase 9/11: app settings (single-user preferences + configurable update cadence
-- + consecutive-failure tracking for the ops-alert health check)

create table if not exists app_settings (
  id                       int primary key default 1 check (id = 1),  -- singleton row, only ever one
  display_name             text,
  digest_email             text,
  price_update_freq        text not null default 'daily'   check (price_update_freq in ('daily', 'weekly', 'monthly')),
  company_refresh_freq     text not null default 'monthly' check (company_refresh_freq in ('daily', 'weekly', 'monthly')),
  last_price_ingest_at     timestamptz,
  last_company_refresh_at  timestamptz,
  price_ingest_fail_streak int not null default 0  -- consecutive failed ingest runs; resets to 0 on success
);
insert into app_settings (id) values (1) on conflict (id) do nothing;
alter table app_settings enable row level security;

-- Storage bucket for on-demand Excel exports the user has downloaded, so they can be re-browsed
-- and re-downloaded later. Private (not public); the app Edge Function (service role) issues
-- short-lived signed URLs for actual downloads, same access pattern as every other table here.
insert into storage.buckets (id, name, public) values ('exports', 'exports', false)
  on conflict (id) do nothing;
