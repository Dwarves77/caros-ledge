-- Down for 0142_provenance_status_once_per_item: the three section and claim triggers run set_provenance_status() per row again, with the body migration 139 gave it; the queue, its trigger and the three new functions go (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER provenance_recheck_apply_trg ON public.provenance_recheck;
DROP TRIGGER set_provenance_status_sections_trg ON public.intelligence_item_sections;
DROP TRIGGER set_provenance_status_claims_trg ON public.section_claim_provenance;
DROP TRIGGER set_provenance_status_claims_del_trg ON public.section_claim_provenance;
CREATE OR REPLACE FUNCTION public.set_provenance_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_item_id    uuid;
  v_validation validation_result;
  v_current    provenance_status;
  v_verified_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'section_claim_provenance' THEN
      v_item_id := OLD.intelligence_item_id;
    ELSIF TG_TABLE_NAME = 'intelligence_item_sections' THEN
      v_item_id := OLD.item_id;
    ELSIF TG_TABLE_NAME = 'intelligence_items' THEN
      v_item_id := OLD.id;
    ELSE
      RETURN OLD;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'intelligence_items' THEN
      v_item_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'intelligence_item_sections' THEN
      v_item_id := NEW.item_id;
    ELSIF TG_TABLE_NAME = 'section_claim_provenance' THEN
      v_item_id := NEW.intelligence_item_id;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  IF v_item_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_validation := public.validate_item_provenance(v_item_id);

  SELECT provenance_status INTO v_current
    FROM public.intelligence_items
   WHERE id = v_item_id;

  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_current IS DISTINCT FROM v_validation.recommended_status THEN
    IF v_validation.recommended_status = 'verified' THEN
      v_verified_at := now();
    ELSE
      v_verified_at := NULL;
    END IF;

    UPDATE public.intelligence_items
       SET provenance_status      = v_validation.recommended_status,
           provenance_verified_at = v_verified_at
     WHERE id = v_item_id;
  END IF;

  IF v_validation.recommended_status = 'quarantined' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.integrity_flags f
       WHERE f.category = 'data_quality'
         AND f.subject_type = 'item'
         AND f.subject_ref = v_item_id::text
         AND f.status = 'open'
    ) THEN
      INSERT INTO public.integrity_flags (
        category, subject_type, subject_ref, description,
        recommended_actions, status, created_by
      )
      VALUES (
        'data_quality',
        'item',
        v_item_id::text,
        'Provenance gate quarantine: item failed one or more of the six provenance criteria on write.',
        jsonb_build_object('failures', v_validation.failures),
        'open',
        'set_provenance_status_trigger'
      );
    END IF;
  END IF;

  IF v_validation.recommended_status = 'verified' THEN
    UPDATE public.integrity_flags
       SET status = 'resolved',
           resolved_at = now(),
           resolved_by = 'set_provenance_status_trigger',
           resolution_note = 'auto-resolved: item re-verified by the provenance gate'
     WHERE category = 'data_quality'
       AND subject_type = 'item'
       AND subject_ref = v_item_id::text
       AND status = 'open'
       AND created_by = 'set_provenance_status_trigger';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;



COMMENT ON FUNCTION public.set_provenance_status() IS 'Sprint 4 Block 1 task 1.4 trigger function, migration 139 revision. AFTER INSERT/UPDATE, stamps provenance_status from validate_item_provenance and (NEW in 139) CLOSES the trigger-opened data_quality flag when the item is verified. Opens a data_quality flag on quarantine (idempotent). Fires only on future writes.';
CREATE TRIGGER set_provenance_status_sections_trg AFTER INSERT OR UPDATE ON public.intelligence_item_sections FOR EACH ROW EXECUTE FUNCTION public.set_provenance_status();
CREATE TRIGGER set_provenance_status_claims_trg AFTER INSERT OR UPDATE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.set_provenance_status();
CREATE TRIGGER set_provenance_status_claims_del_trg AFTER DELETE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.set_provenance_status();
DROP FUNCTION public.provenance_recheck_apply();
DROP FUNCTION public.provenance_recheck_push();
DROP TABLE public.provenance_recheck;
DROP FUNCTION public.apply_provenance_status(uuid);
