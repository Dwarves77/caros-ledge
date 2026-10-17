-- 0043 COMMENT amendment: region_dimension_coverage.notes (P2-S4; coordinator rulings 2026-10-11, the P2-12 entry: "the schema COMMENT 'not rendered to customers directly' is stale and P2-S4 amends it").
--
-- The comment on the column said the narrative is "Surfaced in admin coverage review UI; not rendered to customers directly". P2-12 built the register's behaviour: when a customer selects a region-by-dimension cell of the
-- coverage matrix on /operations, the Panel of src/features/operations/ui/RegionMatrix.tsx draws the cell's note as a plain paragraph under the count, read through readCoverageRows (src/features/operations/read/
-- operations-reads.ts). The comment now says so. A COMMENT changes no object class the catalog diff takes (scripts/ci/catalog-snapshot.sql leaves comments out on purpose), so this file declares `none`.
--
-- Reversal: COMMENT ON COLUMN public.region_dimension_coverage.notes IS 'Operator narrative for why state is partial/pending/missing. Optional. Surfaced in admin coverage review UI; not rendered to customers directly.';

-- catalog: none

BEGIN;

COMMENT ON COLUMN public.region_dimension_coverage.notes IS 'Operator narrative for why state is partial/pending/missing. Optional. Rendered to customers: the Panel of the Operations coverage matrix (src/features/operations/ui/RegionMatrix.tsx) draws it as a plain paragraph under the count when a region-by-dimension cell is selected, and the admin coverage review shows it too.';

-- Self-check 0043-coverage-notes-comment: the comment is the amended text (it names the rendering component and no longer says the column is not rendered to customers).
DO $$
DECLARE c text := col_description('public.region_dimension_coverage'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.region_dimension_coverage'::regclass AND attname = 'notes'));
BEGIN
  IF c IS NULL OR c !~ 'RegionMatrix' OR c ~* 'not rendered to customers directly' THEN RAISE EXCEPTION '0043-coverage-notes-comment: the comment on region_dimension_coverage.notes is not the amended text: %', c; END IF;
  RAISE NOTICE '0043-coverage-notes-comment OK';
END $$;

COMMIT;
