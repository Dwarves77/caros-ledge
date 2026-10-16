-- 0003 ON DELETE SET NULL onto columns that cannot be null (P2-S1, owed by register P1-11 schema.md section 8 "Changed":
-- the four SET NULL foreign keys that cannot set null; INV on SET NULL).
--
-- Each of these deleted its referenced row by failing: SET NULL tried to write NULL into a NOT NULL column (three) or into a
-- column a CHECK requires in the row's state (four: scp_derived_requires_basis, pjr_resolution_consistency,
-- ingest_rejections_triage_consistency, item_forward_events_claim_id_matches_source_kind_check; the last three were found by
-- the new property check, not by the register). The behaviour becomes the honest one:
--   community_groups.owner_user_id, community_post_signoff_requests.requested_by, bulk_imports.imported_by -> ON DELETE RESTRICT
--     (a user who owns or authored these cannot be deleted until ownership is transferred or the rows are resolved);
--   pending_jurisdiction_review.resolved_by, ingest_rejections.triaged_by -> ON DELETE RESTRICT (same: today the delete fails on
--     the consistency CHECK; the error becomes the foreign-key error);
--   section_claim_provenance.basis_claim_id, item_forward_events.source_claim_id -> ON DELETE NO ACTION (a claim cannot be
--     deleted while another claim derives from it or an event is sourced from it; unlike RESTRICT, a statement or a cascade
--     that deletes both in one go still succeeds).
-- No row changes. Not applied to production before the cutover window.
--
-- Reversal: re-create each constraint with ON DELETE SET NULL (restores the failing behaviour).

-- catalog: constraint

BEGIN;

ALTER TABLE public.community_groups DROP CONSTRAINT community_groups_owner_user_id_fkey;
ALTER TABLE public.community_groups ADD CONSTRAINT community_groups_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.community_post_signoff_requests DROP CONSTRAINT community_post_signoff_requests_requested_by_fkey;
ALTER TABLE public.community_post_signoff_requests ADD CONSTRAINT community_post_signoff_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.bulk_imports DROP CONSTRAINT bulk_imports_imported_by_fkey;
ALTER TABLE public.bulk_imports ADD CONSTRAINT bulk_imports_imported_by_fkey
  FOREIGN KEY (imported_by) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.section_claim_provenance DROP CONSTRAINT section_claim_provenance_basis_claim_id_fkey;
ALTER TABLE public.section_claim_provenance ADD CONSTRAINT section_claim_provenance_basis_claim_id_fkey
  FOREIGN KEY (basis_claim_id) REFERENCES public.section_claim_provenance(id) ON DELETE NO ACTION;

ALTER TABLE public.pending_jurisdiction_review DROP CONSTRAINT pending_jurisdiction_review_resolved_by_fkey;
ALTER TABLE public.pending_jurisdiction_review ADD CONSTRAINT pending_jurisdiction_review_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.ingest_rejections DROP CONSTRAINT ingest_rejections_triaged_by_fkey;
ALTER TABLE public.ingest_rejections ADD CONSTRAINT ingest_rejections_triaged_by_fkey
  FOREIGN KEY (triaged_by) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.item_forward_events DROP CONSTRAINT item_forward_events_source_claim_id_fkey;
ALTER TABLE public.item_forward_events ADD CONSTRAINT item_forward_events_source_claim_id_fkey
  FOREIGN KEY (source_claim_id) REFERENCES public.section_claim_provenance(id) ON DELETE NO ACTION;

-- Self-check 0003-set-null: no SET NULL remains on a NOT NULL column or on a column a CHECK requires (the same catalog test
-- scripts/ci/properties.mjs runs as set-null-not-null), and the two replacement actions are the ones stated above.
DO $$
DECLARE bad text; act text;
BEGIN
  SELECT string_agg(c.conrelid::regclass || '.' || a.attname, ', ') INTO bad
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f' AND c.confdeltype = 'n' AND c.connamespace = 'public'::regnamespace
     AND (a.attnotnull OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.conrelid AND k.contype = 'c'
                                    AND a.attnum = ANY (k.conkey) AND pg_get_constraintdef(k.oid) LIKE '%' || a.attname || ' IS NOT NULL%'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0003-set-null: SET NULL still on %', bad; END IF;
  SELECT confdeltype::text INTO act FROM pg_constraint WHERE conname = 'community_groups_owner_user_id_fkey';
  IF act <> 'r' THEN RAISE EXCEPTION '0003-set-null: owner_user_id fkey is % not r', act; END IF;
  SELECT confdeltype::text INTO act FROM pg_constraint WHERE conname = 'section_claim_provenance_basis_claim_id_fkey';
  IF act <> 'a' THEN RAISE EXCEPTION '0003-set-null: basis_claim_id fkey is % not a', act; END IF;
  RAISE NOTICE '0003-set-null OK';
END $$;

COMMIT;
