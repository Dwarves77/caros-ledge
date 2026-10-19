-- Down for 0003_set_null_on_not_null_fix: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
ALTER TABLE public.bulk_imports DROP CONSTRAINT IF EXISTS bulk_imports_imported_by_fkey;
ALTER TABLE public.bulk_imports ADD CONSTRAINT bulk_imports_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.community_groups DROP CONSTRAINT IF EXISTS community_groups_owner_user_id_fkey;
ALTER TABLE public.community_groups ADD CONSTRAINT community_groups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.community_post_signoff_requests DROP CONSTRAINT IF EXISTS community_post_signoff_requests_requested_by_fkey;
ALTER TABLE public.community_post_signoff_requests ADD CONSTRAINT community_post_signoff_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.ingest_rejections DROP CONSTRAINT IF EXISTS ingest_rejections_triaged_by_fkey;
ALTER TABLE public.ingest_rejections ADD CONSTRAINT ingest_rejections_triaged_by_fkey FOREIGN KEY (triaged_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.item_forward_events DROP CONSTRAINT IF EXISTS item_forward_events_source_claim_id_fkey;
ALTER TABLE public.item_forward_events ADD CONSTRAINT item_forward_events_source_claim_id_fkey FOREIGN KEY (source_claim_id) REFERENCES public.section_claim_provenance(id) ON DELETE SET NULL;
ALTER TABLE public.pending_jurisdiction_review DROP CONSTRAINT IF EXISTS pending_jurisdiction_review_resolved_by_fkey;
ALTER TABLE public.pending_jurisdiction_review ADD CONSTRAINT pending_jurisdiction_review_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.section_claim_provenance DROP CONSTRAINT IF EXISTS section_claim_provenance_basis_claim_id_fkey;
ALTER TABLE public.section_claim_provenance ADD CONSTRAINT section_claim_provenance_basis_claim_id_fkey FOREIGN KEY (basis_claim_id) REFERENCES public.section_claim_provenance(id) ON DELETE SET NULL;
