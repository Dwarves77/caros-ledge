-- Down for 0029_market_series_items: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.market_series_items;
