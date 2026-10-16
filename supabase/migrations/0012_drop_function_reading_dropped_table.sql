-- 0012 drop reorder_user_list_item (P2-S1, owed by register P1-11 schema.md section 8 "Dropped" functions; found by the new
-- property check missing-relation-bodies, which flags exactly this function at the baseline).
--
-- reorder_user_list_item(uuid, text, text, text, text, text[]) reads and writes user_list_order, a table old migration 343 dropped.
-- Every call raises "relation user_list_order does not exist". Nothing calls it: no route, script or other function names it
-- (grep over the old tree, 2026-10-15, finds only audit notes and its own creating migration 238). It is dropped, not repaired:
-- the register lists it among the functions the schema drops. No data is involved. Not applied to production before the cutover.
--
-- Reversal: re-create from old_repo/supabase/migrations/238_reorder_user_list_item.sql (it would still fail until its table exists).

-- catalog: function

BEGIN;

DROP FUNCTION public.reorder_user_list_item(uuid, text, text, text, text, text[]);

-- Self-check 0012-drop-dead-function: the function is gone and no function body names it.
DO $$
BEGIN
  IF to_regproc('public.reorder_user_list_item') IS NOT NULL THEN RAISE EXCEPTION '0012: reorder_user_list_item still exists'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ILIKE '%reorder_user_list_item%') THEN
    RAISE EXCEPTION '0012: a function body still names reorder_user_list_item';
  END IF;
  RAISE NOTICE '0012-drop-dead-function OK';
END $$;

COMMIT;
