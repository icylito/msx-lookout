-- Phase 6: watchlist + alerts (app goes live)

create table if not exists watchlist (
  id                   uuid primary key default gen_random_uuid(),
  ticker               text not null references companies(ticker),
  quantity             numeric not null,
  buy_price            numeric not null,
  buy_date             date,
  verified             boolean not null default false,
  verification_source  text,
  created_at           timestamptz not null default now()
);

create table if not exists alerts (
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
