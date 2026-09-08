-- Phase 4: core business logic, exposed automatically as RPC (POST /rest/v1/rpc/<function>).
-- Mirrors logic.sql at the repo root — keep both in sync when either changes.

create extension if not exists pg_trgm; -- typo-tolerant search

-- fuzzy search by ticker, name, or alias
create or replace function search_companies(q text)
returns table (ticker text, name_en text, name_ar text, sector text, market text, score real)
language sql stable as $$
  select c.ticker, c.name_en, c.name_ar, c.sector, c.market,
         greatest(
           case when upper(c.ticker) = upper(q) then 1.0::real else 0 end,
           similarity(c.name_en, q),
           coalesce((select max(similarity(a, q)) from unnest(c.aliases) a), 0)
         ) as score
  from companies c
  where c.active and (
    upper(c.ticker) = upper(q)
    or c.name_en ilike '%' || q || '%'
    or exists (select 1 from unnest(c.aliases) a where a ilike '%' || q || '%')
    or similarity(c.name_en, q) > 0.25
    or exists (select 1 from unnest(c.aliases) a where similarity(a, q) > 0.3)
  )
  order by score desc, c.ticker
  limit 10;
$$;

-- latest price + change vs previous trading day
create or replace function latest_price(p_ticker text)
returns table (ticker text, date date, open numeric, high numeric, low numeric, close numeric,
               volume bigint, prev_close numeric, change numeric, change_pct numeric)
language sql stable as $$
  with last2 as (
    select * from stock_prices
    where ticker = upper(p_ticker) and source = 'msx' and period_type = 'daily'
    order by date desc limit 2
  )
  select l.ticker, l.date, l.open, l.high, l.low, l.close, l.volume,
         p.close, l.close - p.close,
         round((l.close - p.close) / nullif(p.close, 0) * 100, 2)
  from (select * from last2 limit 1) l
  left join (select * from last2 offset 1) p on true;
$$;

-- recent closes for a trend line, oldest first
create or replace function price_trend(p_ticker text, p_days int default 30)
returns table (date date, close numeric, volume bigint)
language sql stable as $$
  select * from (
    select date, close, volume from stock_prices
    where ticker = upper(p_ticker) and source = 'msx' and period_type = 'daily'
    order by date desc limit p_days
  ) t order by date;
$$;

-- Nth trading week back (0 = current), anchored to days actually present (Sun-Thu)
create or replace function trading_week(p_offset int default 0)
returns table (week_start date, week_end date, trading_days int)
language sql stable as $$
  select min(date), max(date), count(*)::int
  from (select distinct date from stock_prices where source = 'msx' and period_type = 'daily') d
  group by (date_trunc('week', date + interval '1 day')::date - 1)
  order by 1 desc
  offset p_offset limit 1;
$$;

-- compare two periods: close at end of each, delta, avg volume (one ticker or all)
create or replace function compare_periods(s1 date, e1 date, s2 date, e2 date, p_ticker text default null)
returns table (ticker text, name_en text, close_1 numeric, close_2 numeric,
               change numeric, change_pct numeric, avg_volume_1 numeric, avg_volume_2 numeric)
language sql stable as $$
  with p1 as (
    select ticker, (array_agg(close order by date desc))[1] as close_end, round(avg(volume)) as avg_vol
    from stock_prices
    where date between s1 and e1 and source = 'msx' and period_type = 'daily'
    group by ticker
  ), p2 as (
    select ticker, (array_agg(close order by date desc))[1] as close_end, round(avg(volume)) as avg_vol
    from stock_prices
    where date between s2 and e2 and source = 'msx' and period_type = 'daily'
    group by ticker
  )
  select c.ticker, c.name_en, p1.close_end, p2.close_end,
         p2.close_end - p1.close_end,
         round((p2.close_end - p1.close_end) / nullif(p1.close_end, 0) * 100, 2),
         p1.avg_vol, p2.avg_vol
  from p1 join p2 using (ticker) join companies c using (ticker)
  where p_ticker is null or p1.ticker = upper(p_ticker)
  order by 6 desc nulls last;
$$;

-- buy-price verification: in-range of that day's low..high, or within 4% of close
create or replace function verify_buy(p_ticker text, p_price numeric, p_date date default null)
returns jsonb
language plpgsql stable as $$
declare
  r record;
  cands jsonb;
begin
  if p_date is not null then
    select * into r from stock_prices
    where ticker = upper(p_ticker) and source = 'msx' and period_type = 'daily'
      and date between p_date - 7 and p_date + 7
    order by abs(date - p_date), date desc limit 1;
    if r is null then
      return jsonb_build_object('verdict', 'no_data',
        'note', 'no trading data within 7 days of the given date');
    end if;
    if (r.low is not null and r.high is not null and p_price between r.low and r.high)
       or abs(p_price - r.close) / r.close <= 0.04 then
      return jsonb_build_object(
        'verdict', case when r.date = p_date then 'verified' else 'verified_nearby' end,
        'date', r.date, 'low', r.low, 'high', r.high, 'close', r.close);
    end if;
    return jsonb_build_object('verdict', 'mismatch',
      'date', r.date, 'low', r.low, 'high', r.high, 'close', r.close);
  end if;

  -- no date given: propose likeliest buy dates
  select jsonb_agg(jsonb_build_object('date', date, 'close', close,
           'diff_pct', round(abs(p_price - close) / close * 100, 2)))
  into cands
  from (
    select date, close from stock_prices
    where ticker = upper(p_ticker) and source = 'msx' and period_type = 'daily'
      and ((low is not null and high is not null and p_price between low and high)
           or abs(p_price - close) / close <= 0.02)
    order by abs(p_price - close), date desc limit 5
  ) t;
  if cands is null then
    return jsonb_build_object('verdict', 'no_match');
  end if;
  return jsonb_build_object('verdict', 'candidates', 'candidates', cands);
end $$;

-- MSX-down state: last confirmed price date + any fallback sources present
create or replace function fallback_state()
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'last_msx_date', max(date) filter (where source = 'msx'),
    'days_stale', current_date - max(date) filter (where source = 'msx'),
    'fallback_sources', coalesce(jsonb_agg(distinct source) filter (where source <> 'msx'), '[]'::jsonb)
  )
  from stock_prices where period_type = 'daily';
$$;

-- watchlist with live prices and personal gain/loss (Phase 6 home screen);
-- recent_action flags a corporate action on the stock in the last 90 days (Phase 8)
drop function if exists watchlist_view();
create or replace function watchlist_view()
returns table (id uuid, ticker text, name_en text, sector text, quantity numeric, buy_price numeric,
               buy_date date, verified boolean, close numeric, change_pct numeric,
               value numeric, gain_loss numeric, has_alert boolean, recent_action text)
language sql stable as $$
  with latest as (
    select distinct on (ticker) ticker, close, date
    from stock_prices where source = 'msx' and period_type = 'daily'
    order by ticker, date desc
  ), prev as (
    select distinct on (sp.ticker) sp.ticker, sp.close
    from stock_prices sp join latest l on l.ticker = sp.ticker and sp.date < l.date
    where sp.source = 'msx' and sp.period_type = 'daily'
    order by sp.ticker, sp.date desc
  )
  select w.id, w.ticker, c.name_en, c.sector, w.quantity, w.buy_price, w.buy_date, w.verified,
         l.close,
         round((l.close - p.close) / nullif(p.close, 0) * 100, 2),
         round(l.close * w.quantity, 3),
         round((l.close - w.buy_price) * w.quantity, 3),
         exists (select 1 from alerts a where a.ticker = w.ticker and a.active),
         (select ca.type from corporate_actions ca
          where ca.ticker = w.ticker and ca.date >= current_date - 90
          order by ca.date desc limit 1)
  from watchlist w
  join companies c using (ticker)
  left join latest l on l.ticker = w.ticker
  left join prev p on p.ticker = w.ticker
  order by c.name_en;
$$;

-- recent corporate actions for one ticker (detail view)
create or replace function ticker_actions(p_ticker text, p_days int default 180)
returns table (date date, type text, title text, link text)
language sql stable as $$
  select date, type, details->>'title', details->>'link'
  from corporate_actions
  where ticker = upper(p_ticker) and date >= current_date - p_days
  order by date desc;
$$;

-- every active company with its latest known price, for the Browse page;
-- days_since flags stale rows so the app knows when to try a gap-fill
create or replace function all_stocks_view()
returns table (ticker text, name_en text, sector text, close numeric,
               change_pct numeric, last_date date, days_since int)
language sql stable as $$
  with latest as (
    select distinct on (ticker) ticker, close, date
    from stock_prices where source = 'msx' and period_type = 'daily'
    order by ticker, date desc
  ), prev as (
    select distinct on (sp.ticker) sp.ticker, sp.close
    from stock_prices sp join latest l on l.ticker = sp.ticker and sp.date < l.date
    where sp.source = 'msx' and sp.period_type = 'daily'
    order by sp.ticker, sp.date desc
  )
  select c.ticker, c.name_en, c.sector, l.close,
         round((l.close - p.close) / nullif(p.close, 0) * 100, 2),
         l.date,
         (current_date - l.date)
  from companies c
  left join latest l on l.ticker = c.ticker
  left join prev p on p.ticker = c.ticker
  where c.active
  order by c.name_en;
$$;

-- weekly/monthly rollups computed from daily rows (nothing extra is scraped)
create or replace view weekly_prices with (security_invoker = true) as
  select ticker,
         (date_trunc('week', date + interval '1 day')::date - 1) as week_start,
         max(date) as last_day,
         (array_agg(open order by date))[1] as open,
         max(high) as high, min(low) as low,
         (array_agg(close order by date desc))[1] as close,
         sum(volume) as volume, sum(turnover) as turnover, sum(trades) as trades
  from stock_prices
  where source = 'msx' and period_type = 'daily'
  group by ticker, 2;

create or replace view monthly_prices with (security_invoker = true) as
  select ticker,
         date_trunc('month', date)::date as month_start,
         max(date) as last_day,
         (array_agg(open order by date))[1] as open,
         max(high) as high, min(low) as low,
         (array_agg(close order by date desc))[1] as close,
         sum(volume) as volume, sum(turnover) as turnover, sum(trades) as trades
  from stock_prices
  where source = 'msx' and period_type = 'daily'
  group by ticker, 2;
