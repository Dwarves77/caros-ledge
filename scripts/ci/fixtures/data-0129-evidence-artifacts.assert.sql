-- Assertions about the FIXTURE of 0129_data_evidence_artifacts_move.sql, run in the same rolled-back transaction after the file (apply-notes.json "assert"): the JSON list moved and its text cleared; prose, a refused array and NULL are untouched.
DO $$
DECLARE r public.obligation_objects;
BEGIN
  SELECT * INTO r FROM public.obligation_objects WHERE obligation_id = 'cl:obligation:0129000000000001';
  IF r.evidence_artifacts IS DISTINCT FROM '[{"class":"declaration_of_conformity","name":"EU declaration of conformity"}]'::jsonb OR r.evidence_required IS NOT NULL THEN RAISE EXCEPTION 'data-0129 assertions: the artifact list did not move: %', r.evidence_artifacts; END IF;
  SELECT * INTO r FROM public.obligation_objects WHERE obligation_id = 'cl:obligation:0129000000000002';
  IF r.evidence_artifacts IS NOT NULL OR r.evidence_required <> 'Keep the declaration for ten years.' THEN RAISE EXCEPTION 'data-0129 assertions: prose was touched'; END IF;
  SELECT * INTO r FROM public.obligation_objects WHERE obligation_id = 'cl:obligation:0129000000000003';
  IF r.evidence_artifacts IS NOT NULL OR r.evidence_required <> '[1, 2]' THEN RAISE EXCEPTION 'data-0129 assertions: a refused array was moved or cleared'; END IF;
  SELECT * INTO r FROM public.obligation_objects WHERE obligation_id = 'cl:obligation:0129000000000004';
  IF r.evidence_artifacts IS NOT NULL OR r.evidence_required IS NOT NULL THEN RAISE EXCEPTION 'data-0129 assertions: a NULL row changed'; END IF;
  RAISE NOTICE 'data-0129 assertions OK';
END $$;
