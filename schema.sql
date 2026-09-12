-- MSX Stock Lookout schema (Phase 1)
-- NOTE (2026-07-28, Phase 12): this file is now a read-only reference snapshot.
-- The real, executable source of truth is supabase/migrations/*.sql, applied
-- automatically by CI (supabase db push) on every push to main. Make schema
-- changes by adding a new migration file, not by editing this one directly.

create table companies (
  ticker    text primary key,
  name_en   text not null,
  name_ar   text,
  aliases   text[] not null default '{}',
  sector    text,
  market    text,
  exchange  text not null default 'MSX',
  active    boolean not null default true
);

-- append-only fact table, never overwritten
create table stock_prices (
  ticker       text not null,
  date         date not null,
  open         numeric,          -- null for backfilled history (MSX history has no open)
  high         numeric,
  low          numeric,
  close        numeric,
  volume       bigint,
  turnover     numeric,
  trades       integer,
  source       text not null,    -- 'msx' | 'investing' | 'marketscreener'
  period_type  text not null default 'daily',
  primary key (ticker, date, source, period_type)
);

create index stock_prices_date on stock_prices (date);

create table corporate_actions (
  id       uuid primary key default gen_random_uuid(),
  ticker   text,
  date     date not null,
  type     text not null,        -- split, bonus shares, dividend, capital increase...
  details  jsonb
);

-- each circular has a unique PDF link; that's the real dedupe key
create unique index corporate_actions_link on corporate_actions ((details->>'link'));

-- block anonymous API access; service role bypasses RLS
alter table companies enable row level security;
alter table stock_prices enable row level security;
alter table corporate_actions enable row level security;

-- Phase 6: watchlist + alerts (app goes live)

create table watchlist (
  id                   uuid primary key default gen_random_uuid(),
  ticker               text not null references companies(ticker),
  quantity             numeric not null,
  buy_price            numeric not null,
  buy_date             date,
  verified             boolean not null default false,
  verification_source  text,
  created_at           timestamptz not null default now()
);

create table alerts (
  id               uuid primary key default gen_random_uuid(),
  ticker           text not null references companies(ticker),
  condition        text not null check (condition in ('below', 'above')),
  threshold_price  numeric not null,
  active           boolean not null default true,
  fired_at         timestamptz,          -- set when the alert fires; alert deactivates
  created_at       timestamptz not null default now()
);

alter table watchlist enable row level security;
alter table alerts enable row level security;

-- Phase 9: app settings (single-user preferences + configurable update cadence)
create table app_settings (
  id                       int primary key default 1 check (id = 1),  -- singleton row, only ever one
  display_name             text,
  digest_email             text,
  price_update_freq        text not null default 'daily'   check (price_update_freq in ('daily', 'weekly', 'monthly')),
  company_refresh_freq     text not null default 'monthly' check (company_refresh_freq in ('daily', 'weekly', 'monthly')),
  last_price_ingest_at     timestamptz,
  last_company_refresh_at  timestamptz,
  price_ingest_fail_streak int not null default 0  -- consecutive failed ingest runs; resets to 0 on success
);
insert into app_settings (id) values (1);
alter table app_settings enable row level security;

-- Storage bucket for on-demand Excel exports the user has downloaded, so they can be re-browsed
-- and re-downloaded later. Private (not public); the app Edge Function (service role) issues
-- short-lived signed URLs for actual downloads, same access pattern as every other table here.
insert into storage.buckets (id, name, public) values ('exports', 'exports', false)
  on conflict (id) do nothing;
