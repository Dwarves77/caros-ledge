-- 0072 DATA self-check: the six EU Oil Bulletin attachments and their weekly cadence (R1b, remediation G6; good-enough audit K:39, K:6 for 0030).
--
-- 0030 attached six series to their items and printed a NOTICE for any item that was absent; it asserted nothing, so a load that attached nothing ended `OK`. 0045 asserted that no weekly series was left without a cadence,
-- but over the rows 0030 inserted: when 0030 inserted nothing the assertion ran over zero rows and passed. Applied files are never edited, so this file re-proves both, forward: on the database it runs against, all six series
-- exist, ratified, with their item, each with the weekly cadence. It changes no row. On production it is the first assertion that the six attachments are there at all; if an item was absent when 0030 ran, it names the series.
--
-- THIS IS A DATA MIGRATION (it reads rows the cutover loaded). TWO-TRACK POLICY: it runs at the cutover window after 0045; the CI schema job runs it inside a rolled-back transaction after the fixture below, which holds the six
-- items and attachments, and (apply-notes.json) it is attacked by removing the fixture.
-- irreversible: nothing to undo; the file changes no row

-- catalog: none
-- rollback-test: scripts/ci/fixtures/data-0072-series.sql

BEGIN;

-- Self-check 0072-market-series: all six series exist, ratified, with an item and the weekly cadence.
DO $$
DECLARE keys text[] := ARRAY['eu-oil-bulletin:eurosuper-95', 'eu-oil-bulletin:automotive-diesel', 'eu-oil-bulletin:heating-gas-oil', 'eu-oil-bulletin:lpg-motor-fuel', 'eu-oil-bulletin:residual-fuel-oil-1pct', 'eu-oil-bulletin:heavy-fuel-oil-3-5pct'];
  absent text; slow text;
BEGIN
  SELECT string_agg(k, ', ' ORDER BY k) INTO absent FROM unnest(keys) k
   WHERE NOT EXISTS (SELECT 1 FROM public.market_series_items m WHERE m.series_key = k AND m.status = 'ratified' AND m.item_id IS NOT NULL);
  IF absent IS NOT NULL THEN RAISE EXCEPTION '0072-market-series: no ratified attachment with an item for: %', absent; END IF;
  SELECT string_agg(m.series_key, ', ' ORDER BY m.series_key) INTO slow FROM public.market_series_items m WHERE m.series_key = ANY (keys) AND m.cadence_days IS DISTINCT FROM 7;
  IF slow IS NOT NULL THEN RAISE EXCEPTION '0072-market-series: not on the weekly cadence: %', slow; END IF;
  RAISE NOTICE '0072-market-series OK';
END $$;

COMMIT;
