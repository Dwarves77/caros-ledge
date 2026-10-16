-- 0009 item_corrections outbox (P2-S1, owed by register P1-10 flywheel-b.md section 8 "Gaps" 1: corrections are outside Loop B;
-- ruling recorded in P1-11 schema.md section 8 "Rulings owed" 2: emit a propagation event on insert and on revoke, entity = the
-- item's instrument entity).
--
-- Before: a suppressed, replaced, added or removed fact moved no derived value, no inference and no recalculation notice,
-- because item_corrections carried no outbox trigger. After: every correction row (insert) and every revoke (the one UPDATE the
-- append-only trigger allows) writes to propagation_events, in the same transaction:
--   1. table_name 'intelligence_items', row_pk = the item id, entity_id = the item's instrument_entity_id (NULL when the item
--      has none), change_kind 'update', old_row = the correction row before a revoke (NULL on insert), new_row = the correction
--      row. Edges a derived value or inference holds on the item (from_table 'intelligence_items', widened in 0010) are
--      invalidated by the drain through its ordinary invalidate_dependents walk.
--   2. For a fact correction (target_kind 'fact') a second event, table_name 'section_claim_provenance', row_pk = the claim id
--      (target_ref), same entity, so an edge held on the claim itself is invalidated precisely.
-- The payload is the correction row, not an image of the item: a reader of these events knows why the event exists.
-- The function is SECURITY DEFINER with a pinned path so the event is written whoever issued the correction, and it is callable
-- by nobody (a trigger function needs no caller privilege). It never blocks the correction: an item without an entity still
-- emits, with a NULL entity. Not applied to production before the cutover window.
--
-- Reversal: DROP TRIGGER item_corrections_outbox_trg ON public.item_corrections; DROP FUNCTION public.emit_item_correction_event();

-- catalog: function, trigger

BEGIN;

CREATE OR REPLACE FUNCTION public.emit_item_correction_event() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity text;
  v_old jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_old := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    v_old := to_jsonb(OLD);
  ELSE
    RETURN NEW;
  END IF;

  SELECT i.instrument_entity_id INTO v_entity FROM public.intelligence_items i WHERE i.id = NEW.item_id;

  INSERT INTO public.propagation_events (table_name, row_pk, entity_id, change_kind, old_row, new_row)
  VALUES ('intelligence_items', NEW.item_id::text, v_entity, 'update', v_old, to_jsonb(NEW));

  IF NEW.target_kind = 'fact' THEN
    INSERT INTO public.propagation_events (table_name, row_pk, entity_id, change_kind, old_row, new_row)
    VALUES ('section_claim_provenance', NEW.target_ref, v_entity, 'update', v_old, to_jsonb(NEW));
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.emit_item_correction_event() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emit_item_correction_event() TO service_role;

COMMENT ON FUNCTION public.emit_item_correction_event() IS
  'P2-S1 0009. AFTER INSERT OR UPDATE on item_corrections: writes the propagation event(s) a correction or its revoke owes Loop B. See the migration header.';

CREATE TRIGGER item_corrections_outbox_trg AFTER INSERT OR UPDATE ON public.item_corrections
  FOR EACH ROW EXECUTE FUNCTION public.emit_item_correction_event();

-- Self-check 0009-corrections-outbox: the attack is a real correction and a real revoke against the live trigger chain; the
-- fixtures are rolled back by raising inside a sub-block.
DO $$
DECLARE v_item uuid := gen_random_uuid(); v_user uuid := gen_random_uuid(); v_corr uuid; n int;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (v_user, 'selfcheck@example.invalid');
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES ('cl:instrument:selfcheck0009', 'instrument', 'selfcheck 0009');
    INSERT INTO public.intelligence_items (id, title, domain, instrument_entity_id)
      VALUES (v_item, 'selfcheck 0009', 1, 'cl:instrument:selfcheck0009');
    INSERT INTO public.item_corrections (item_id, target_kind, target_ref, op, reason, created_by)
      VALUES (v_item, 'tag', 'topic_tags:selfcheck', 'add', 'selfcheck', v_user) RETURNING id INTO v_corr;
    SELECT count(*) INTO n FROM public.propagation_events
     WHERE table_name = 'intelligence_items' AND row_pk = v_item::text AND entity_id = 'cl:instrument:selfcheck0009' AND old_row IS NULL;
    IF n <> 1 THEN RAISE EXCEPTION '0009-corrections-outbox: insert emitted % events, expected 1', n; END IF;
    UPDATE public.item_corrections SET revoked_at = now(), revoked_by = v_user, revoked_reason = 'selfcheck' WHERE id = v_corr;
    SELECT count(*) INTO n FROM public.propagation_events
     WHERE table_name = 'intelligence_items' AND row_pk = v_item::text AND old_row IS NOT NULL;
    IF n <> 1 THEN RAISE EXCEPTION '0009-corrections-outbox: revoke emitted % events, expected 1', n; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0009-corrections-outbox: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '0009-corrections-outbox: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('authenticated', 'public.emit_item_correction_event()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.emit_item_correction_event()', 'EXECUTE') THEN
    RAISE EXCEPTION '0009-corrections-outbox: trigger function is callable by a client role';
  END IF;
  RAISE NOTICE '0009-corrections-outbox OK';
END $$;

COMMIT;
