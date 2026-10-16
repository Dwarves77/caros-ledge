-- 0022 a deleted resolver or triager nulls out (P2-S3, owed by IMPROVEMENTS IMP-019; supersedes the RESTRICT that 0003 left on two columns
-- "pending this ruling").
--
-- pending_jurisdiction_review.resolved_by and ingest_rejections.triaged_by record who closed a review row. Their consistency CHECKs required
-- the closer to be present whenever the row was closed, so deleting that user could neither set the column null (the CHECK refused it) nor
-- cascade; 0003 made the foreign keys RESTRICT, which turned the CHECK failure into a foreign-key failure but still blocked user deletion
-- over review bookkeeping. The ruling: bookkeeping does not block deletion.
--   pjr_resolution_consistency:  open (no resolved_at, resolved_by, resolution_value) OR closed (resolved_at set); resolved_by may be null.
--   ingest_rejections_triage_consistency: untriaged (no action, by, at) OR triaged (action and at set); triaged_by may be null.
-- and both foreign keys become ON DELETE SET NULL again. The state is still all-or-nothing on the facts that matter (when, and what was
-- decided); only "who" may be lost to a deleted account. No row changes. Not applied to production before the cutover window.
--
-- Reversal: restore the two CHECKs from supabase/schema.sql and re-create both foreign keys ON DELETE RESTRICT (0003's state).

-- catalog: constraint

BEGIN;

ALTER TABLE public.pending_jurisdiction_review DROP CONSTRAINT pjr_resolution_consistency;
ALTER TABLE public.pending_jurisdiction_review ADD CONSTRAINT pjr_resolution_consistency CHECK (
  (resolved_at IS NULL AND resolved_by IS NULL AND resolution_value IS NULL) OR (resolved_at IS NOT NULL));
ALTER TABLE public.pending_jurisdiction_review DROP CONSTRAINT pending_jurisdiction_review_resolved_by_fkey;
ALTER TABLE public.pending_jurisdiction_review ADD CONSTRAINT pending_jurisdiction_review_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.ingest_rejections DROP CONSTRAINT ingest_rejections_triage_consistency;
ALTER TABLE public.ingest_rejections ADD CONSTRAINT ingest_rejections_triage_consistency CHECK (
  (triage_action IS NULL AND triaged_by IS NULL AND triaged_at IS NULL) OR (triage_action IS NOT NULL AND triaged_at IS NOT NULL));
ALTER TABLE public.ingest_rejections DROP CONSTRAINT ingest_rejections_triaged_by_fkey;
ALTER TABLE public.ingest_rejections ADD CONSTRAINT ingest_rejections_triaged_by_fkey
  FOREIGN KEY (triaged_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Self-check 0022-review-nulls-out: in a fixture that rolls back, deleting the resolver (and the triager) leaves the closed rows closed with a
-- NULL "who"; and the relaxed CHECKs still refuse what they exist to refuse: a closed row with no time, a triaged row with no action or no
-- time, a half-open row (a closer with nothing closed).
DO $$
DECLARE u uuid := gen_random_uuid(); item uuid; pjr uuid; rej uuid; r record;
BEGIN
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'pending_jurisdiction_review_resolved_by_fkey') <> 'n'
     OR (SELECT confdeltype FROM pg_constraint WHERE conname = 'ingest_rejections_triaged_by_fkey') <> 'n' THEN
    RAISE EXCEPTION '0022-review-nulls-out: a foreign key is not ON DELETE SET NULL';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u, 'selfcheck-0022@invalid.example');
    INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0022', 1) RETURNING id INTO item;
    INSERT INTO public.pending_jurisdiction_review (intelligence_item_id, current_value, flagged_reason, resolved_by, resolved_at, resolution_value)
      VALUES (item, 'selfcheck-0022', 'continent', u, now(), 'US') RETURNING id INTO pjr;
    INSERT INTO public.ingest_rejections (raw_value, rejection_reason, triaged_by, triaged_at, triage_action)
      VALUES ('selfcheck-0022', 'unparseable', u, now(), 'discarded') RETURNING id INTO rej;
    DELETE FROM auth.users WHERE id = u;
    SELECT resolved_by, resolved_at, resolution_value INTO r FROM public.pending_jurisdiction_review WHERE id = pjr;
    IF r.resolved_by IS NOT NULL OR r.resolved_at IS NULL OR r.resolution_value IS DISTINCT FROM 'US' THEN
      RAISE EXCEPTION '0022-review-nulls-out: the resolved row did not keep its decision with a NULL resolver (%)', r;
    END IF;
    SELECT triaged_by, triaged_at, triage_action INTO r FROM public.ingest_rejections WHERE id = rej;
    IF r.triaged_by IS NOT NULL OR r.triaged_at IS NULL OR r.triage_action IS DISTINCT FROM 'discarded' THEN
      RAISE EXCEPTION '0022-review-nulls-out: the triaged row did not keep its decision with a NULL triager (%)', r;
    END IF;
    BEGIN
      UPDATE public.pending_jurisdiction_review SET resolved_at = NULL WHERE id = pjr;
      RAISE EXCEPTION '0022-review-nulls-out: a resolution with no time was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.ingest_rejections SET triage_action = NULL WHERE id = rej;
      RAISE EXCEPTION '0022-review-nulls-out: a triage with no action was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.ingest_rejections SET triaged_at = NULL WHERE id = rej;
      RAISE EXCEPTION '0022-review-nulls-out: a triage with no time was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.ingest_rejections (raw_value, rejection_reason, triaged_by) VALUES ('selfcheck-0022-half', 'unparseable', gen_random_uuid());
      RAISE EXCEPTION '0022-review-nulls-out: a triager with nothing triaged was accepted';
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0022-review-nulls-out OK';
END $$;

COMMIT;
