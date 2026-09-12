-- Pin an explicit search_path on the SQL functions so it can't be hijacked via a
-- user-controlled schema (Supabase security advisor 0011, function_search_path_mutable).
-- All ten are SECURITY INVOKER and reference public objects (tables + pg_trgm) unqualified,
-- so the path stays `public` (with pg_temp last) rather than empty, which would break them.
alter function public.all_stocks_view()                              set search_path = public, pg_temp;
alter function public.compare_periods(date, date, date, date, text)  set search_path = public, pg_temp;
alter function public.fallback_state()                               set search_path = public, pg_temp;
alter function public.latest_price(text)                             set search_path = public, pg_temp;
alter function public.price_trend(text, integer)                     set search_path = public, pg_temp;
alter function public.search_companies(text)                         set search_path = public, pg_temp;
alter function public.ticker_actions(text, integer)                  set search_path = public, pg_temp;
alter function public.trading_week(integer)                          set search_path = public, pg_temp;
alter function public.verify_buy(text, numeric, date)                set search_path = public, pg_temp;
alter function public.watchlist_view()                               set search_path = public, pg_temp;
