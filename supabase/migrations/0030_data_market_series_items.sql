-- 0030 DATA migration: the six ratified series-to-item attachments into market_series_items (P2-11, owed by register P1-20 market.md section 8: the ratified map becomes a table).
--
-- The rows are the ratified entries of src/features/market/producers/data/series-item-map.json (tests/market/seed.test.ts proves the two agree entry for entry). Do not edit one without the other.
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (src/features/market/read.ts readMarketDetail) and is RUN ONLY AT THE CUTOVER WINDOW, by the operator's executor, after 0029; the CI schema job never runs it for real,
-- it runs it inside a rolled-back transaction after the fixture named below (rule 15: the SQL is proven to execute).
--
-- Idempotent: INSERT ... ON CONFLICT (series_key) DO NOTHING, so a second run, or an attachment ruled since, is never overwritten. An item id that is absent from intelligence_items is listed in a NOTICE and skipped, never invented.
-- Reversal: DELETE FROM public.market_series_items WHERE series_key IN (the six keys below).

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0030-items.sql

BEGIN;

CREATE TEMP TABLE _msi_in (series_key text PRIMARY KEY, item_id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO _msi_in (series_key, item_id) VALUES
('eu-oil-bulletin:eurosuper-95', '4fae403a-ced5-4c8f-82b7-af0fd6127061'),
('eu-oil-bulletin:automotive-diesel', '70869a22-39eb-4eb7-ba49-d3826b5b2265'),
('eu-oil-bulletin:heating-gas-oil', '32783a47-0073-4cff-a2ae-369508bcdfe9'),
('eu-oil-bulletin:lpg-motor-fuel', '2d306cc6-084d-44d0-ae88-bb391767f787'),
('eu-oil-bulletin:residual-fuel-oil-1pct', '0ee667cc-a403-4fe3-b5f8-4f829a4a9103'),
('eu-oil-bulletin:heavy-fuel-oil-3-5pct', '180b8163-6ae5-4f35-98dd-02e46c06b561');

DO $$
DECLARE absent text;
BEGIN
  SELECT string_agg(i.series_key, ', ' ORDER BY i.series_key) INTO absent FROM _msi_in i WHERE NOT EXISTS (SELECT 1 FROM public.intelligence_items x WHERE x.id = i.item_id);
  IF absent IS NOT NULL THEN RAISE NOTICE '0030: skipped, the item is not in intelligence_items: %', absent; END IF;
END $$;

INSERT INTO public.market_series_items (series_key, item_id, status)
SELECT i.series_key, i.item_id, 'ratified' FROM _msi_in i WHERE EXISTS (SELECT 1 FROM public.intelligence_items x WHERE x.id = i.item_id)
ON CONFLICT (series_key) DO NOTHING;

COMMIT;
