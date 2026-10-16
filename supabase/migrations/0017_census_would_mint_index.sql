-- 0017 census_worklist would-mint partial index (P2-S2, owed by IMPROVEMENTS IMP-040).
--
-- The mint selection read pages the whole census pool each run to find the rows the dry run marked would_mint, live and
-- enumerated. A partial index over exactly those rows (dryrun_disposition, is_archived, enumeration_status WHERE
-- dryrun_disposition = 'would_mint') lets that read touch only them; every other disposition stays out of the index.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP INDEX public.census_worklist_would_mint_idx.

-- catalog: index

BEGIN;

CREATE INDEX census_worklist_would_mint_idx ON public.census_worklist (dryrun_disposition, is_archived, enumeration_status)
  WHERE dryrun_disposition = 'would_mint';

-- Self-check 0017-would-mint-index: the index exists, is partial on would_mint, and covers the three columns in order.
DO $$
DECLARE def text;
BEGIN
  SELECT i.indexdef INTO def FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = 'census_worklist_would_mint_idx';
  IF def IS NULL THEN RAISE EXCEPTION '0017-would-mint-index: the index does not exist'; END IF;
  IF def NOT LIKE '%(dryrun_disposition, is_archived, enumeration_status)%' THEN
    RAISE EXCEPTION '0017-would-mint-index: wrong columns: %', def;
  END IF;
  IF NOT (SELECT x.indpred IS NOT NULL FROM pg_index x WHERE x.indexrelid = 'public.census_worklist_would_mint_idx'::regclass) THEN
    RAISE EXCEPTION '0017-would-mint-index: the index is not partial';
  END IF;
  IF def NOT LIKE '%WHERE (dryrun_disposition = ''would_mint''::text)%' THEN
    RAISE EXCEPTION '0017-would-mint-index: wrong predicate: %', def;
  END IF;
  RAISE NOTICE '0017-would-mint-index OK';
END $$;

COMMIT;
