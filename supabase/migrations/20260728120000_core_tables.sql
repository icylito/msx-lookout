-- Phase 1: core tables (companies, stock_prices, corporate_actions)

create table if not exists companies (
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
create table if not exists stock_prices (
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

create index if not exists stock_prices_date on stock_prices (date);

create table if not exists corporate_actions (
  id       uuid primary key default gen_random_uuid(),
  ticker   text,
  date     date not null,
  type     text not null,        -- split, bonus shares, dividend, capital increase...
  details  jsonb
);

-- each circular has a unique PDF link; that's the real dedupe key
create unique index if not exists corporate_actions_link on corporate_actions ((details->>'link'));

-- block anonymous API access; service role bypasses RLS
alter table companies enable row level security;
alter table stock_prices enable row level security;
alter table corporate_actions enable row level security;
