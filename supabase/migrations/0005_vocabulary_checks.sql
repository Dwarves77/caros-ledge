-- 0005 vocabulary CHECKs (P2-S1, owed by register P1-11 schema.md section 8 "Changed": monitoring_queue_last_result_check,
-- state_cost_facts dimension, user_watchlist item_type; capture.md section 8 for the last_result values written).
--
--   monitoring_queue.last_result: the change-detection pass (check-sources logic.ts:152) writes change_detected, no_change, or
--     the reachability token inconclusive or dead (reachability.mjs REACH); the baseline CHECK allowed no_change, updated,
--     new_item, error, inaccessible, so every change-flagged and every non-answer row was refused and its error dropped. The
--     CHECK becomes the union: the five existing values stay (no row can fail, and the other writers keep working) plus the
--     three the code writes. The capture slice's one vocabulary constant must equal this list.
--   state_cost_facts.dimension: gains grid_intensity, the seventh Operations dimension; regional_data_facts and
--     region_dimension_coverage already carry it (old migration 378), state_cost_facts was missed.
--   user_watchlist.item_type: gains market_series, as org_watchlist already admits.
-- Existing rows satisfy every widened list. Not applied to production before the cutover window.
--
-- Reversal: re-create each CHECK with its baseline list (valid only while no row uses a new value).

-- catalog: constraint

BEGIN;

ALTER TABLE public.monitoring_queue DROP CONSTRAINT monitoring_queue_last_result_check;
ALTER TABLE public.monitoring_queue ADD CONSTRAINT monitoring_queue_last_result_check
  CHECK (last_result IS NULL OR last_result = ANY (ARRAY['no_change', 'updated', 'new_item', 'error', 'inaccessible',
                                                          'change_detected', 'inconclusive', 'dead']));

ALTER TABLE public.state_cost_facts DROP CONSTRAINT state_cost_facts_dimension_check;
ALTER TABLE public.state_cost_facts ADD CONSTRAINT state_cost_facts_dimension_check
  CHECK (dimension = ANY (ARRAY['regulatory_feasibility', 'regional_resources', 'labor_markets', 'materials_sourcing',
                                'infrastructure', 'operational_cost', 'grid_intensity']));

ALTER TABLE public.user_watchlist DROP CONSTRAINT user_watchlist_item_type_check;
ALTER TABLE public.user_watchlist ADD CONSTRAINT user_watchlist_item_type_check
  CHECK (item_type = ANY (ARRAY['source', 'reg', 'signal', 'research', 'operations', 'market_series']));

-- Self-check 0005-vocabulary: the live constraint text contains every value the writers use (read from the catalog, not the file).
DO $$
DECLARE def text; v text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'monitoring_queue_last_result_check';
  FOREACH v IN ARRAY ARRAY['change_detected', 'no_change', 'inconclusive', 'dead'] LOOP
    IF def NOT LIKE '%''' || v || '''%' THEN RAISE EXCEPTION '0005-vocabulary: last_result CHECK lacks %', v; END IF;
  END LOOP;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'state_cost_facts_dimension_check';
  IF def NOT LIKE '%grid_intensity%' THEN RAISE EXCEPTION '0005-vocabulary: state_cost_facts dimension lacks grid_intensity'; END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'user_watchlist_item_type_check';
  IF def NOT LIKE '%market_series%' THEN RAISE EXCEPTION '0005-vocabulary: user_watchlist item_type lacks market_series'; END IF;
  RAISE NOTICE '0005-vocabulary OK';
END $$;

COMMIT;
