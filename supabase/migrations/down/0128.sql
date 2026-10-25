-- down/0128.sql: reverses 0128_obligation_evidence_artifacts.sql. The artifacts return to evidence_required as JSON text where that column is empty; then the constraint and the column go.
UPDATE public.obligation_objects SET evidence_required = evidence_artifacts::text WHERE evidence_artifacts IS NOT NULL AND evidence_required IS NULL;
ALTER TABLE public.obligation_objects DROP CONSTRAINT obligation_objects_evidence_artifacts_shape_check, DROP COLUMN evidence_artifacts;
