-- Watchlist no longer requires investment info — adding a stock to monitor
-- is separate from recording a position bought at a price.
alter table watchlist alter column quantity drop not null;
alter table watchlist alter column buy_price drop not null;
