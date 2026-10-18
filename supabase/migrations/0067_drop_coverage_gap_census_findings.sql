-- 0067 drop coverage_gap_census_findings (P2-15 PART A; rulings-2026-10-11 ruling 16: the dead-table drop returns to the cutover list as export-then-drop).
--
-- coverage_gap_census_findings (116 rows in production, a Session C discovery census artifact) has no reader and no writer in the new tree, and the view census_rollup_by_surface that stitched it to census_worklist has no
-- consumer either (register schema.md section 6, C2 line 187). DESTRUCTIVE: the rows are exported FIRST by `node scripts/cutover/export-table.mjs coverage_gap_census_findings`, which writes
-- docs/archive/logs/<window date>-coverage_gap_census_findings.json in THIS repo (the old repo is retired in P2-17) and prints the row count and the sha256 of the file; the operator compares the count with
-- `select count(*) from public.coverage_gap_census_findings` before this file runs. supabase/migrations/APPLY.md lists this file as "after the export". The view is dropped first, then the table; nothing else in the schema
-- reads either (the missing-relation-bodies property check and the self-check below prove it).
-- Not applied to production before the cutover window.
--
-- Reversal: none from SQL. Restore the table from the export file (columns are in supabase/schema.sql, section coverage_gap_census_findings).

-- catalog: relation, column, constraint, index, acl

BEGIN;

DROP VIEW public.census_rollup_by_surface;
DROP TABLE public.coverage_gap_census_findings;

-- Self-check 0067-drop-census-findings: both relations are gone, no policy or index of the table remains, and no function in public names either (a body that still read the table would fail at its next call).
DO $$
BEGIN
  IF to_regclass('public.coverage_gap_census_findings') IS NOT NULL OR to_regclass('public.census_rollup_by_surface') IS NOT NULL THEN RAISE EXCEPTION '0067-drop-census-findings: a relation is still there'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'coverage_gap_census_findings') THEN RAISE EXCEPTION '0067-drop-census-findings: a policy of the table is still there'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.prosrc LIKE '%coverage_gap_census_findings%' OR p.prosrc LIKE '%census_rollup_by_surface%')) THEN
    RAISE EXCEPTION '0067-drop-census-findings: a function still names a dropped relation';
  END IF;
  RAISE NOTICE '0067-drop-census-findings OK';
END $$;

COMMIT;
