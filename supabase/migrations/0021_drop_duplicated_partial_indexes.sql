-- 0021 drop four duplicated partial indexes (P2-S3, owed by IMPROVEMENTS IMP-018).
--
-- Each of these four partial single-column indexes (WHERE the column IS NOT NULL) is covered by the full index 0002 added for the same
-- foreign-key column; the partial one costs a write on every row touched and answers nothing the full one does not:
--   derived_values_supersedes_idx             covered by derived_values_supersedes_fk_idx             (supersedes)
--   entities_merged_into_idx                  covered by entities_merged_into_fk_idx                  (merged_into)
--   inference_records_supersedes_idx          covered by inference_records_supersedes_fk_idx          (supersedes)
--   research_assessments_entity_id_idx        covered by research_assessments_entity_id_fk_idx        (entity_id)
-- Not applied to production before the cutover window.
--
-- Reversal: CREATE INDEX <name> ON <table> (<column>) WHERE <column> IS NOT NULL, for each of the four.

-- catalog: index

BEGIN;

DROP INDEX public.derived_values_supersedes_idx;
DROP INDEX public.entities_merged_into_idx;
DROP INDEX public.inference_records_supersedes_idx;
DROP INDEX public.research_assessments_entity_id_idx;

-- Self-check 0021-drop-duplicates: the four are gone, and each column is still led by a full (non-partial, valid) index. The covering test is
-- itself attacked first: on a planted table whose only index is partial it must report "not covered".
DO $$
DECLARE r record; n int;
BEGIN
  CREATE FUNCTION pg_temp.covered(t regclass, c text) RETURNS boolean LANGUAGE sql STABLE AS $f$
    SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                    WHERE i.indrelid = t AND a.attname = c AND i.indpred IS NULL AND i.indisvalid AND i.indexprs IS NULL)
  $f$;
  CREATE TEMP TABLE planted_partial (id int, ref int) ON COMMIT DROP;
  CREATE INDEX planted_partial_ref_idx ON planted_partial (ref) WHERE ref IS NOT NULL;
  IF pg_temp.covered('planted_partial'::regclass, 'ref') THEN RAISE EXCEPTION '0021-drop-duplicates: the covering test accepts a partial index'; END IF;
  CREATE INDEX planted_partial_full_idx ON planted_partial (ref);
  IF NOT pg_temp.covered('planted_partial'::regclass, 'ref') THEN RAISE EXCEPTION '0021-drop-duplicates: the covering test rejects a full index'; END IF;
  SELECT count(*) INTO n FROM pg_indexes WHERE schemaname = 'public'
     AND indexname IN ('derived_values_supersedes_idx', 'entities_merged_into_idx', 'inference_records_supersedes_idx', 'research_assessments_entity_id_idx');
  IF n <> 0 THEN RAISE EXCEPTION '0021-drop-duplicates: % of the four indexes still exist', n; END IF;
  FOR r IN SELECT * FROM (VALUES ('public.derived_values', 'supersedes'), ('public.entities', 'merged_into'),
                                 ('public.inference_records', 'supersedes'), ('public.research_assessments', 'entity_id')) v(t, c) LOOP
    IF NOT pg_temp.covered(r.t::regclass, r.c) THEN RAISE EXCEPTION '0021-drop-duplicates: % (%) has no full index left', r.t, r.c; END IF;
  END LOOP;
  DROP FUNCTION pg_temp.covered(regclass, text);
  RAISE NOTICE '0021-drop-duplicates OK';
END $$;

COMMIT;
