-- 0147 ets_maritime_item_replaced_by: the item "EU Emissions Trading System (ETS) Extension to Maritime Transport" (ff4064ab, identifier 2023/958) is replaced by the held Directive (EU) 2023/959 item (15f63ea9) (CONTENT-1b, coordinator ruling (i)).
-- change: intelligence_items ff4064ab-9489-4fc4-b3cc-f0f157e71db5 takes replaced_by 15f63ea9-4803-4bb4-b1a3-9ccdeb8a3050
--
-- Before: ff4064ab carried identifier 2023/958 and source_url CELEX:32023L0958, but its own capture of that URL is a 2,989-character EUR-Lex "Page Not Found" page, so no text of 2023/958 is held; its brief
-- grounds the maritime extension (surrender 40/70/100 %, 5 000 gross tonnage, 30 September) on Commission, EMSA and EUR-Lex summary pages, and its own what_is_it names Directive (EU) 2023/959 as the enacting act.
-- 15f63ea9 is the 2023/959 item: verified, not archived, its brief grounded on the 959 Official Journal text (Article 3gb phase-in included). Read-only queries on production, 2026-10-31.
-- After: ff4064ab is no longer admissible (item_is_admissible, migrations 0092/0095/0096: replaced_by IS NOT NULL), so lists and joins show the 2023/959 item in its place. Nothing is deleted: the item, its claims,
-- events and edges stay, and the replacement is one column.
-- On a database that does not hold ff4064ab (the CI database) the file changes nothing and says so; where it does, the self-check requires the target verified and not archived, exactly one row changed, and the column read back.
-- Access: unchanged. Reversal: down/0147.sql sets replaced_by back to NULL for ff4064ab where it still names 15f63ea9.

-- catalog: none

BEGIN;

DO $$
DECLARE
  v_item constant uuid := 'ff4064ab-9489-4fc4-b3cc-f0f157e71db5';
  v_target constant uuid := '15f63ea9-4803-4bb4-b1a3-9ccdeb8a3050';
  v_rows integer;
  v_now uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.intelligence_items WHERE id = v_item) THEN
    RAISE NOTICE '0147-ets-maritime-item-replaced-by: item % is not held here, nothing replaced', v_item;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.intelligence_items WHERE id = v_target AND provenance_status = 'verified' AND is_archived = false AND replaced_by IS NULL) THEN
      RAISE EXCEPTION '0147-ets-maritime-item-replaced-by: the replacement % is not a verified, unarchived, unreplaced item', v_target;
    END IF;
    UPDATE public.intelligence_items SET replaced_by = v_target, updated_at = now() WHERE id = v_item AND replaced_by IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '0147-ets-maritime-item-replaced-by: % row(s) changed, expected exactly 1', v_rows;
    END IF;
    SELECT replaced_by INTO v_now FROM public.intelligence_items WHERE id = v_item;
    IF v_now IS DISTINCT FROM v_target THEN
      RAISE EXCEPTION '0147-ets-maritime-item-replaced-by: replaced_by reads back %, expected %', v_now, v_target;
    END IF;
  END IF;
  RAISE NOTICE '0147-ets-maritime-item-replaced-by OK';
END $$;

COMMIT;
