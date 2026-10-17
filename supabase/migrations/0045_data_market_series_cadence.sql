-- 0045 DATA migration: the weekly cadence of the six EU Oil Bulletin attachments (P2-S4, IMP-084 follow-up; the cadence_days the code file series-item-map.json carried, now a column from 0044).
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (src/features/market/producers/market-series-items.ts readSeriesItemMap) and is RUN ONLY AT THE CUTOVER WINDOW, after 0030 (which inserts the six rows) and
-- 0044 (which adds the column); the CI schema job never commits it, it runs it inside a rolled-back transaction after the fixture named below (rule 15: the SQL is proven to execute, and the file asserts its own result).
--
-- Idempotent: a series whose cadence_days is already set (ruled since) is never overwritten. Reversal: UPDATE public.market_series_items SET cadence_days = NULL WHERE series_key IN (the six keys below).

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0045-series.sql

BEGIN;

CREATE TEMP TABLE _msc_before ON COMMIT DROP AS SELECT series_key, cadence_days FROM public.market_series_items WHERE cadence_days IS NOT NULL;

UPDATE public.market_series_items SET cadence_days = 7
 WHERE cadence_days IS NULL
   AND series_key IN ('eu-oil-bulletin:eurosuper-95', 'eu-oil-bulletin:automotive-diesel', 'eu-oil-bulletin:heating-gas-oil', 'eu-oil-bulletin:lpg-motor-fuel', 'eu-oil-bulletin:residual-fuel-oil-1pct', 'eu-oil-bulletin:heavy-fuel-oil-3-5pct');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.market_series_items WHERE cadence_days IS NULL AND series_key IN ('eu-oil-bulletin:eurosuper-95', 'eu-oil-bulletin:automotive-diesel', 'eu-oil-bulletin:heating-gas-oil', 'eu-oil-bulletin:lpg-motor-fuel', 'eu-oil-bulletin:residual-fuel-oil-1pct', 'eu-oil-bulletin:heavy-fuel-oil-3-5pct')) THEN
    RAISE EXCEPTION '0045: a weekly series was left without its cadence';
  END IF;
  IF EXISTS (SELECT 1 FROM _msc_before b JOIN public.market_series_items m USING (series_key) WHERE m.cadence_days IS DISTINCT FROM b.cadence_days) THEN
    RAISE EXCEPTION '0045: a cadence ruled before the load was overwritten';
  END IF;
  RAISE NOTICE '0045 OK';
END $$;

COMMIT;
