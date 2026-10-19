-- Down for 0044_market_series_items_display: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
ALTER TABLE public.market_series_items DROP CONSTRAINT market_series_items_cadence_days_check;
ALTER TABLE public.market_series_items DROP CONSTRAINT market_series_items_severity_tone_check;
ALTER TABLE public.market_series_items DROP COLUMN cadence_days;
ALTER TABLE public.market_series_items DROP COLUMN context_line;
ALTER TABLE public.market_series_items DROP COLUMN severity_tone;
