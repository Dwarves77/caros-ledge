-- 0127 DATA migration: move the artifact lists CTX-5 stored as JSON text in obligation_objects.evidence_required into obligation_objects.evidence_artifacts, and clear the text (CTX-6).
--
-- A row whose evidence_required is a JSON array (text starting with `[`) and whose evidence_artifacts is empty is cast to jsonb and written to evidence_artifacts, and evidence_required is set NULL. A row whose text is not JSON, or whose
-- array the 0126 CHECK refuses (not an array of {class, name}), keeps its text and is counted: the file prints the counts moved and left. Prose in evidence_required is never touched. A second run changes nothing.
-- Production held 1868 obligation objects and no evidence_required value at the time of writing (read-only query, 2026-10-24), so the file moves nothing there; it exists so that no environment keeps the artifact list in text.
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (derive-objects writes the column, relevance.ts reads it) and runs after 0126; the CI schema job runs it once in a rolled-back transaction after the fixture named below.
--
-- irreversible: UPDATE public.obligation_objects SET evidence_required = evidence_artifacts::text, evidence_artifacts = NULL WHERE evidence_artifacts IS NOT NULL AND evidence_required IS NULL; (only the rows the file moved had both the artifacts and an empty text)

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0127-evidence-artifacts.sql

BEGIN;

DO $$
DECLARE
  r record;
  v_moved integer := 0;
  v_left integer := 0;
BEGIN
  FOR r IN SELECT obligation_id, evidence_required FROM public.obligation_objects WHERE evidence_artifacts IS NULL AND evidence_required ~ '^\s*\[' ORDER BY obligation_id LOOP
    BEGIN
      UPDATE public.obligation_objects SET evidence_artifacts = r.evidence_required::jsonb, evidence_required = NULL WHERE obligation_id = r.obligation_id;
      v_moved := v_moved + 1;
    EXCEPTION WHEN check_violation OR invalid_text_representation THEN
      v_left := v_left + 1;
    END;
  END LOOP;
  RAISE NOTICE '0127: % rows moved, % left in text (not an array of class and name)', v_moved, v_left;
END $$;

-- Self-check 0127-evidence-artifacts-move: no row carries the list in both columns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.obligation_objects WHERE evidence_artifacts IS NOT NULL AND evidence_required IS NOT NULL) THEN RAISE EXCEPTION '0127-evidence-artifacts-move: a row carries artifacts in both columns'; END IF;
  RAISE NOTICE '0127-evidence-artifacts-move OK';
END $$;

COMMIT;
