-- Cached dividend history, scraped best-effort from stockanalysis.com (the one third-party
-- source that answers a plain server-side request; MSX's own reports page is reCAPTCHA-gated).
-- This is a convenience cache, never load-bearing: the UI always falls back to a link-out if a
-- row is missing. Idempotent by (ticker, ex_date) so re-scrapes upsert cleanly.
create table if not exists dividends (
  ticker      text not null references companies(ticker) on delete cascade,
  ex_date     date not null,
  amount      numeric,           -- cash per share, OMR (null if the source omitted it)
  record_date date,
  pay_date    date,
  source      text not null default 'stockanalysis',
  fetched_at  timestamptz not null default now(),
  primary key (ticker, ex_date)
);
create index if not exists dividends_ticker_exdate_idx on dividends (ticker, ex_date desc);
alter table dividends enable row level security;
