-- Down for 0022_review_bookkeeping_nulls_out: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
ALTER TABLE public.ingest_rejections DROP CONSTRAINT IF EXISTS ingest_rejections_triage_consistency;
ALTER TABLE public.ingest_rejections ADD CONSTRAINT ingest_rejections_triage_consistency CHECK ((((triage_action IS NULL) AND (triaged_by IS NULL) AND (triaged_at IS NULL)) OR ((triage_action IS NOT NULL) AND (triaged_by IS NOT NULL) AND (triaged_at IS NOT NULL))));
ALTER TABLE public.ingest_rejections DROP CONSTRAINT IF EXISTS ingest_rejections_triaged_by_fkey;
ALTER TABLE public.ingest_rejections ADD CONSTRAINT ingest_rejections_triaged_by_fkey FOREIGN KEY (triaged_by) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.pending_jurisdiction_review DROP CONSTRAINT IF EXISTS pending_jurisdiction_review_resolved_by_fkey;
ALTER TABLE public.pending_jurisdiction_review ADD CONSTRAINT pending_jurisdiction_review_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.pending_jurisdiction_review DROP CONSTRAINT IF EXISTS pjr_resolution_consistency;
ALTER TABLE public.pending_jurisdiction_review ADD CONSTRAINT pjr_resolution_consistency CHECK ((((resolved_at IS NULL) AND (resolved_by IS NULL) AND (resolution_value IS NULL)) OR ((resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL))));
