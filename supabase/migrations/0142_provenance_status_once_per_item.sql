-- 0142 provenance_status_once_per_item: a transaction validates each item it touched once, at commit, not once per section or claim row written (PROV-TRIG-1).
-- change: the section and claim triggers queue the item and a deferred constraint trigger validates it once per transaction; the status logic moves into apply_provenance_status(uuid)
--
-- Before: AFTER INSERT/UPDATE/DELETE row triggers on intelligence_item_sections and section_claim_provenance each ran set_provenance_status(), which ran validate_item_provenance(item) over the whole item (about 14.5 ms
-- on a 12-section item). The cost was rows x validate(item): ledger_reconcile_sections on item b293a2b6 (12 sections) timed out at the 8 s statement timeout in the DRAIN-1 apply (184 ms on a quiet database), and a
-- cascade delete of N claims validated the item N times. Measured by a rolled-back production probe (DRAIN-FIX-2, 2026-10-26).
-- After: the same three row triggers (same names, same events) now only record "this item needs its status derived in this transaction" in provenance_recheck, one row per (item, transaction) however many rows were
-- written. A DEFERRABLE INITIALLY DEFERRED constraint trigger on provenance_recheck fires once per queued row at commit, when every write of the transaction is visible, and runs the unchanged derivation: validate_item_provenance,
-- the status stamp, the data_quality flag opened on quarantine and resolved on verify. A transaction that writes 12 sections and 30 claims of one item validates it once.
--
-- Why a deferred constraint trigger and not a statement-level trigger with transition tables: the writers loop (ledger_reconcile_sections updates one section per statement, ledger_apply_ops writes one claim per op), so a
-- statement-level trigger still validates once per statement, 12 times for a 12-section reconcile. Only a per-transaction dedup reaches one. The dedup key lives in a table no client role can touch (not a session setting,
-- which any caller could forge to suppress the derivation: the mig-118 lesson), written only by the SECURITY DEFINER push trigger.
-- What does not change: the derived provenance_status, provenance_verified_at, the data_quality flag and every refusal. guard_provenance_flip is untouched (the derivation still writes at trigger depth 2). The items trigger
-- set_provenance_status_trg (AFTER INSERT/UPDATE on intelligence_items, depth 0) is untouched and still derives per item write. validate_item_provenance is untouched.
-- What does change, stated: (1) the status of an item whose sections or claims were written inside a still-open transaction is derived at COMMIT, not after each statement, so a transaction that must read the status of such an
-- item before it commits runs SET CONSTRAINTS ALL IMMEDIATE first (every in-repo writer is one RPC = one transaction and reads the status after it commits); (2) a write to an item the transaction also deleted derives nothing
-- (it derived nothing before either: the status read found no row); (3) the item-update stamp keeps app.keep_updated_at as it was when the rows were written (queued with the row, restored around the derivation), so a
-- ledger_apply_ops keep_updated_at write still does not move updated_at.
--
-- Access: provenance_recheck is RLS-on with no policy and no grant to any role (the SECURITY DEFINER push and apply functions own it); apply_provenance_status(uuid) is executable by service_role and reconciler only, the roles
-- that can fire the items trigger. Reversal: down/0142.sql restores the three row triggers on set_provenance_status() with its previous body and drops the queue, its functions and trigger.

-- catalog: relation, column, constraint, index, function, trigger, acl

BEGIN;

-- The derivation, extracted unchanged from set_provenance_status() (migration 139 revision). An item that does not exist derives nothing (the old code validated it first and then found no row: no side effect either way).
CREATE FUNCTION public.apply_provenance_status(p_item_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_validation  validation_result;
  v_current     provenance_status;
  v_verified_at timestamptz;
BEGIN
  IF p_item_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.intelligence_items WHERE id = p_item_id) THEN
    RETURN;
  END IF;

  v_validation := public.validate_item_provenance(p_item_id);

  SELECT provenance_status INTO v_current
    FROM public.intelligence_items
   WHERE id = p_item_id;

  IF NOT FOUND THEN
    RETURN;
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
     WHERE id = p_item_id;
  END IF;

  IF v_validation.recommended_status = 'quarantined' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.integrity_flags f
       WHERE f.category = 'data_quality'
         AND f.subject_type = 'item'
         AND f.subject_ref = p_item_id::text
         AND f.status = 'open'
    ) THEN
      INSERT INTO public.integrity_flags (
        category, subject_type, subject_ref, description,
        recommended_actions, status, created_by
      )
      VALUES (
        'data_quality',
        'item',
        p_item_id::text,
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
       AND subject_ref = p_item_id::text
       AND status = 'open'
       AND created_by = 'set_provenance_status_trigger';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.apply_provenance_status(uuid) IS 'Migration 0142. The provenance derivation for one item: validate_item_provenance, stamp provenance_status (and provenance_verified_at), open the data_quality flag on quarantine, resolve it on verify. The body of set_provenance_status() (migration 139), extracted so the items trigger and the deferred per-transaction trigger run the same code. An absent item derives nothing.';

-- The items trigger keeps its name, events and WHEN clause; only its body now delegates. Sections and claims no longer call it.
CREATE OR REPLACE FUNCTION public.set_provenance_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_item_id uuid;
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

  PERFORM public.apply_provenance_status(v_item_id);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMENT ON FUNCTION public.set_provenance_status() IS 'Sprint 4 Block 1 task 1.4 trigger function, migration 139 revision, delegating since migration 0142. AFTER INSERT/UPDATE on intelligence_items (set_provenance_status_trg, depth 0): derives the item''s provenance_status through apply_provenance_status(uuid). The section and claim tables no longer fire it: they queue the item (provenance_recheck_push) and the derivation runs once per transaction at commit (provenance_recheck_apply).';

CREATE TABLE public.provenance_recheck (
  item_id uuid NOT NULL,
  xid bigint NOT NULL,
  keep_updated_at boolean NOT NULL DEFAULT false
);
ALTER TABLE public.provenance_recheck ADD CONSTRAINT provenance_recheck_pkey PRIMARY KEY (item_id, xid);

COMMENT ON TABLE public.provenance_recheck IS 'Migration 0142. One row per (item, transaction) whose sections or claims were written: the dedup key of the deferred provenance derivation. Written only by provenance_recheck_push (SECURITY DEFINER), consumed (deleted) by provenance_recheck_apply at commit, so it is empty between transactions. No role holds a grant: a caller that could delete or pre-insert a row could suppress the derivation of its own write. A row left behind means the deferred trigger is disabled.';

ALTER TABLE public.provenance_recheck ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provenance_recheck FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.provenance_recheck_push() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_item_id uuid;
  v_keep    boolean := coalesce(current_setting('app.keep_updated_at', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'section_claim_provenance' THEN
      v_item_id := OLD.intelligence_item_id;
    ELSIF TG_TABLE_NAME = 'intelligence_item_sections' THEN
      v_item_id := OLD.item_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'section_claim_provenance' THEN
      v_item_id := NEW.intelligence_item_id;
    ELSIF TG_TABLE_NAME = 'intelligence_item_sections' THEN
      v_item_id := NEW.item_id;
    END IF;
  END IF;

  IF v_item_id IS NOT NULL THEN
    -- The first write of the transaction queues the item (and fires the deferred trigger once, on this INSERT); a later write in the same transaction is a no-op, except that a write made with
    -- keep_updated_at off turns the flag off: the stamp keeps updated_at only if every write that queued it did.
    INSERT INTO public.provenance_recheck (item_id, xid, keep_updated_at)
    VALUES (v_item_id, txid_current(), v_keep)
    ON CONFLICT (item_id, xid) DO UPDATE SET keep_updated_at = false
      WHERE public.provenance_recheck.keep_updated_at AND NOT EXCLUDED.keep_updated_at;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.provenance_recheck_push() IS 'Migration 0142. AFTER INSERT/UPDATE (sections, claims) and AFTER DELETE (claims) row trigger: queues the written row''s item once per transaction in provenance_recheck. SECURITY DEFINER because no role may write the queue. The item it queues is the one the old per-row trigger validated (NEW for insert and update, OLD for delete).';

CREATE FUNCTION public.provenance_recheck_apply() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_keep boolean;
  v_prev text;
BEGIN
  DELETE FROM public.provenance_recheck WHERE item_id = NEW.item_id AND xid = NEW.xid RETURNING keep_updated_at INTO v_keep;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_prev := current_setting('app.keep_updated_at', true);
  PERFORM set_config('app.keep_updated_at', CASE WHEN v_keep THEN 'on' ELSE 'off' END, true);
  PERFORM public.apply_provenance_status(NEW.item_id);
  PERFORM set_config('app.keep_updated_at', coalesce(v_prev, ''), true);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.provenance_recheck_apply() IS 'Migration 0142. DEFERRABLE INITIALLY DEFERRED constraint trigger function on provenance_recheck: at commit, once per (item, transaction), consumes the queue row and runs apply_provenance_status(item) with app.keep_updated_at as the queued writes had it. SET CONSTRAINTS ALL IMMEDIATE runs it at once. SECURITY DEFINER: it must delete the queue row, and it stamps with the same rights the ledger functions write with.';

REVOKE ALL ON FUNCTION public.apply_provenance_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_provenance_status(uuid) TO service_role, reconciler;
REVOKE ALL ON FUNCTION public.provenance_recheck_push() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.provenance_recheck_apply() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER set_provenance_status_sections_trg ON public.intelligence_item_sections;
DROP TRIGGER set_provenance_status_claims_trg ON public.section_claim_provenance;
DROP TRIGGER set_provenance_status_claims_del_trg ON public.section_claim_provenance;
CREATE TRIGGER set_provenance_status_sections_trg AFTER INSERT OR UPDATE ON public.intelligence_item_sections FOR EACH ROW EXECUTE FUNCTION public.provenance_recheck_push();
CREATE TRIGGER set_provenance_status_claims_trg AFTER INSERT OR UPDATE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.provenance_recheck_push();
CREATE TRIGGER set_provenance_status_claims_del_trg AFTER DELETE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.provenance_recheck_push();
CREATE CONSTRAINT TRIGGER provenance_recheck_apply_trg AFTER INSERT ON public.provenance_recheck DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.provenance_recheck_apply();

-- Self-check 0142-provenance-once: shape and access; then, in a fixture that rolls back (every status is read with SET CONSTRAINTS ALL IMMEDIATE, the commit-time derivation run on demand): the equivalence with the derivation
-- (a valid item verifies, an unlabeled assertion quarantines it and opens the flag, the repair verifies it and resolves the flag, a FACT with no span quarantines it and deleting the claim verifies it again, emptying the sections quarantines
-- it, a cascade delete of an item derives nothing and raises nothing); the dedup (12 section updates and a 30-claim cascade delete of one item queue exactly one row, and the status is not derived until the trigger runs);
-- and the attacks, each of which must be refused or caught: a direct flip of a quarantined item to verified by service_role (guard_provenance_flip), a service_role delete of the queue row to suppress a derivation, a service_role insert of
-- a queue row, and a section write that makes a verified item unverified (the derivation is not skippable by a writer).
DO $$
DECLARE
  src uuid; it uuid; sec uuid; sec2 uuid; st text; flags int; i int; q int;
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('set_provenance_status_sections_trg', 'set_provenance_status_claims_trg', 'set_provenance_status_claims_del_trg') AND tgfoid = 'public.provenance_recheck_push()'::regprocedure AND tgenabled = 'O' AND NOT tgdeferrable) <> 3 THEN
    RAISE EXCEPTION '0142-provenance-once: the three queue triggers are not in place';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'provenance_recheck_apply_trg' AND tgrelid = 'public.provenance_recheck'::regclass AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred AND tgenabled = 'O') <> 1 THEN
    RAISE EXCEPTION '0142-provenance-once: the deferred apply trigger is not a deferrable-initially-deferred enabled constraint trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_provenance_status_trg' AND tgrelid = 'public.intelligence_items'::regclass AND tgfoid = 'public.set_provenance_status()'::regprocedure AND tgenabled = 'O') THEN
    RAISE EXCEPTION '0142-provenance-once: the items trigger changed';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provenance_recheck'::regclass)
     OR has_table_privilege('anon', 'public.provenance_recheck', 'SELECT') OR has_table_privilege('authenticated', 'public.provenance_recheck', 'SELECT')
     OR has_table_privilege('service_role', 'public.provenance_recheck', 'SELECT') OR has_table_privilege('service_role', 'public.provenance_recheck', 'INSERT')
     OR has_table_privilege('service_role', 'public.provenance_recheck', 'DELETE') OR has_table_privilege('service_role', 'public.provenance_recheck', 'UPDATE') THEN
    RAISE EXCEPTION '0142-provenance-once: the queue table is open to a client role';
  END IF;
  IF has_function_privilege('anon', 'public.apply_provenance_status(uuid)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.apply_provenance_status(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.provenance_recheck_push()', 'EXECUTE') OR has_function_privilege('service_role', 'public.provenance_recheck_apply()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.apply_provenance_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0142-provenance-once: unexpected EXECUTE privileges';
  END IF;

  BEGIN
    INSERT INTO public.sources (name, url, base_tier, tier_at_creation) VALUES ('selfcheck-0142 source', 'https://selfcheck-0142.invalid/', 1, 1) RETURNING id INTO src;
    INSERT INTO public.intelligence_items (title, domain, source_id, full_brief) VALUES ('selfcheck-0142 item', 1, src, 'A brief.') RETURNING id INTO it;
    INSERT INTO public.item_gate_a_state (intelligence_item_id, gate_a_version, scanned_hash, orphan_count) VALUES (it, 'selfcheck', md5('A brief.'), 0);
    -- Production seeds item_type_required_slots (criterion 5 wants a FACT or GAP claim naming each slot of the item type; the CI database has none), so the fixture satisfies whatever the live table asks of its item type: one GAP claim per required slot, on a section of its own that no step below deletes.
    INSERT INTO public.intelligence_item_sections (item_id, section_key, section_order, content_md) VALUES (it, 'selfcheck-slots', 99, 'Slots.') RETURNING id INTO sec2;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, section_row_id, claim_kind, claim_text)
      SELECT it, sec2, 'GAP', r.slot_key FROM public.item_type_required_slots r WHERE r.item_type = (SELECT i.item_type FROM public.intelligence_items i WHERE i.id = it);
    -- A valid section: the item verifies (and the derivation has not run before the trigger does).
    INSERT INTO public.intelligence_item_sections (item_id, section_key, section_order, content_md) VALUES (it, 's1', 1, 'A plain statement with no assertion words.') RETURNING id INTO sec;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st = 'verified' THEN RAISE EXCEPTION '0142-provenance-once: the status was derived before the deferred trigger ran'; END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st <> 'verified' THEN RAISE EXCEPTION '0142-provenance-once: a valid item did not verify (%)', st; END IF;
    IF EXISTS (SELECT 1 FROM public.provenance_recheck WHERE item_id = it) THEN RAISE EXCEPTION '0142-provenance-once: the queue was not consumed'; END IF;
    -- An unlabeled assertion: quarantined, flag opened; repaired: verified, flag resolved.
    UPDATE public.intelligence_item_sections SET content_md = 'The operator must file a report.' WHERE id = sec;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    SELECT count(*) INTO flags FROM public.integrity_flags WHERE subject_ref = it::text AND status = 'open' AND created_by = 'set_provenance_status_trigger';
    IF st <> 'quarantined' OR flags <> 1 THEN RAISE EXCEPTION '0142-provenance-once: an unlabeled assertion left % with % open flag(s)', st, flags; END IF;
    UPDATE public.intelligence_item_sections SET content_md = 'A plain statement again.' WHERE id = sec;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    SELECT count(*) INTO flags FROM public.integrity_flags WHERE subject_ref = it::text AND status = 'open' AND created_by = 'set_provenance_status_trigger';
    IF st <> 'verified' OR flags <> 0 THEN RAISE EXCEPTION '0142-provenance-once: the repair left % with % open flag(s)', st, flags; END IF;
    -- A FACT with no span quarantines; deleting the claim (the delete trigger) verifies again.
    INSERT INTO public.section_claim_provenance (intelligence_item_id, section_row_id, claim_kind, claim_text) VALUES (it, sec, 'FACT', 'a fact with no span');
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st <> 'quarantined' THEN RAISE EXCEPTION '0142-provenance-once: a FACT with no span left %', st; END IF;
    DELETE FROM public.section_claim_provenance WHERE intelligence_item_id = it AND claim_kind = 'FACT';
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st <> 'verified' THEN RAISE EXCEPTION '0142-provenance-once: deleting the bad claim left %', st; END IF;
    -- The dedup: 12 sections, 12 updates, 30 claims, one cascade delete of the claims: exactly one queue row for the item, not derived until the trigger runs.
    FOR i IN 2..12 LOOP
      INSERT INTO public.intelligence_item_sections (item_id, section_key, section_order, content_md) VALUES (it, 's' || i, i, 'Plain statement ' || i || '.');
    END LOOP;
    FOR i IN 1..12 LOOP
      UPDATE public.intelligence_item_sections SET content_md = 'Plain statement revised ' || i || '.' WHERE item_id = it AND section_order = i;
    END LOOP;
    FOR i IN 1..30 LOOP
      INSERT INTO public.section_claim_provenance (intelligence_item_id, section_row_id, claim_kind, claim_text) VALUES (it, sec, 'GAP', 'gap ' || i);
    END LOOP;
    DELETE FROM public.intelligence_item_sections WHERE item_id = it AND section_order = 1;
    SELECT count(*) INTO q FROM public.provenance_recheck WHERE item_id = it;
    IF q <> 1 THEN RAISE EXCEPTION '0142-provenance-once: % queue rows for one item in one transaction (expected 1)', q; END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    IF EXISTS (SELECT 1 FROM public.provenance_recheck WHERE item_id = it) THEN RAISE EXCEPTION '0142-provenance-once: the queue was not consumed after the batch'; END IF;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st <> (public.validate_item_provenance(it)).recommended_status::text THEN RAISE EXCEPTION '0142-provenance-once: the stamped status % is not the derivation', st; END IF;
    -- Emptying every section quarantines (no_section_content).
    UPDATE public.intelligence_item_sections SET content_md = '' WHERE item_id = it;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st <> 'quarantined' THEN RAISE EXCEPTION '0142-provenance-once: empty sections left %', st; END IF;
    -- ATTACK 1: a section write that makes a VERIFIED item unverified cannot be skipped by the writer (service_role, the queue is not theirs to touch).
    UPDATE public.intelligence_item_sections SET content_md = 'Plain again.' WHERE item_id = it;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st <> 'verified' THEN RAISE EXCEPTION '0142-provenance-once: attack setup: item is %', st; END IF;
    SET LOCAL ROLE service_role;
    BEGIN DELETE FROM public.provenance_recheck WHERE item_id = it; RAISE EXCEPTION '0142-provenance-once: service_role deleted from the queue';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN INSERT INTO public.provenance_recheck (item_id, xid) VALUES (it, txid_current()); RAISE EXCEPTION '0142-provenance-once: service_role wrote the queue';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    UPDATE public.intelligence_item_sections SET content_md = 'The operator must file a report.' WHERE item_id = it AND section_order = 2;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    RESET ROLE;
    SELECT provenance_status::text INTO st FROM public.intelligence_items WHERE id = it;
    IF st = 'verified' THEN RAISE EXCEPTION '0142-provenance-once: a service_role section write left an unverifiable item verified'; END IF;
    -- ATTACK 2: a direct flip of the quarantined item to verified by service_role is refused by guard_provenance_flip.
    SET LOCAL ROLE service_role;
    BEGIN UPDATE public.intelligence_items SET provenance_status = 'verified' WHERE id = it; RAISE EXCEPTION '0142-provenance-once: service_role flipped an item to verified';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    -- A cascade delete of the item (its sections and claims go with it) derives nothing and raises nothing, and leaves nothing queued.
    DELETE FROM public.intelligence_items WHERE id = it;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    IF EXISTS (SELECT 1 FROM public.provenance_recheck WHERE item_id = it) THEN RAISE EXCEPTION '0142-provenance-once: the cascade delete left a queue row'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0142-provenance-once OK';
END $$;

COMMIT;
