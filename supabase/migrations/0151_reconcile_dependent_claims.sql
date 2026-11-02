-- 0151 reconcile_dependent_claims: ledger_reconcile_sections archives and removes the DERIVED/GAP claims that rest on a claim of a vanishing section, so a brief replacement no longer fails on basis_claim_id (RECONCILE-FK-1, wave P58, ruling 73).
-- change: CREATE OR REPLACE ledger_reconcile_sections (same signature, same grants); before a vanishing section is deleted, every claim that rests on one of its claims by basis_claim_id (transitively, in any section) is archived to
-- claim_versions (orphaned_no_prose_referent, proof reason basis_claim_removed) and deleted, its item_forward_events are re-pointed at their own capture, then the section goes.
--
-- Before: the section delete cascades to the section's claims; section_claim_provenance.basis_claim_id (NO ACTION, 0003) refused it whenever a surviving or later-deleted DERIVED claim rested on a FACT of the vanishing
-- section. Production, 2026-11-02: item 51b2c91e (reg-action-12, DERIVED rows in kept sections 8 and 14) and item e5c17fac (operations-23, DERIVED rows in kept sections 1 and 7) both returned
-- 'ledger_reconcile_sections: update or delete on table "section_claim_provenance" violates foreign key constraint "section_claim_provenance_basis_claim_id_fkey"' and the step read partial. After: the reconcile completes;
-- the superseded legacy DERIVED/GAP claims are in claim_versions (nothing is dropped unarchived) and the new brief's claims stand. A forward event resting on a dependent claim with no capture still fails the reconcile loudly.
-- Access: unchanged (service_role only). Reversal: down/0151.sql restores the 0074 body.

-- catalog: function

BEGIN;

CREATE OR REPLACE FUNCTION public.ledger_reconcile_sections(p_item_id uuid, p_sections jsonb, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  s record;
  v_keys text[];
  v_removed integer := 0;
  v_archived integer := 0;
  v_updated integer := 0;
  v_inserted integer := 0;
  v_dep_claims integer := 0;
  v_dep uuid[];
  ev record;
  n integer;
BEGIN
  IF p_item_id IS NULL OR p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' OR jsonb_array_length(p_sections) = 0 THEN
    RAISE EXCEPTION 'ledger_reconcile_sections needs an item and a non-empty sections array' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item % not found', p_item_id USING ERRCODE = 'P0002'; END IF;
  SELECT array_agg(e ->> 'section_key') INTO v_keys FROM jsonb_array_elements(p_sections) e;
  IF EXISTS (SELECT 1 FROM unnest(v_keys) k WHERE k IS NULL OR k = '') OR (SELECT count(DISTINCT k) FROM unnest(v_keys) k) <> cardinality(v_keys) THEN
    RAISE EXCEPTION 'every section needs a distinct section_key' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.intelligence_item_sections WHERE item_id = p_item_id FOR UPDATE;
  FOR s IN SELECT id, section_key FROM public.intelligence_item_sections WHERE item_id = p_item_id AND NOT (section_key = ANY (v_keys)) ORDER BY section_key LOOP
    -- 0151: a claim of the vanishing section may be the basis of a DERIVED or GAP claim elsewhere (a kept section, or a section that goes later in this loop). basis_claim_id is a foreign key with no cascade and a
    -- DERIVED claim cannot exist without its basis (scp_derived_requires_basis), so the section delete failed on it. The dependents (transitively) are archived to claim_versions with the reason they went, their forward
    -- events are re-pointed at their own capture, and they are deleted before the section; the new brief's claims replace them (ruling 73). Nothing is dropped unarchived.
    WITH RECURSIVE dep(id) AS (
      SELECT d.id FROM public.section_claim_provenance d JOIN public.section_claim_provenance b ON d.basis_claim_id = b.id WHERE b.section_row_id = s.id
      UNION
      SELECT d.id FROM public.section_claim_provenance d JOIN dep ON d.basis_claim_id = dep.id)
    SELECT array_agg(c.id) INTO v_dep FROM dep JOIN public.section_claim_provenance c ON c.id = dep.id WHERE c.section_row_id IS DISTINCT FROM s.id;
    IF v_dep IS NOT NULL THEN
      FOR ev IN SELECT e.id AS event_id, c.search_result_id FROM public.item_forward_events e JOIN public.section_claim_provenance c ON c.id = e.source_claim_id WHERE e.source_claim_id = ANY (v_dep) LOOP
        IF ev.search_result_id IS NULL THEN
          RAISE EXCEPTION 'forward event % rests on a dependent claim with no capture; it cannot keep a link', ev.event_id USING ERRCODE = '23503';
        END IF;
        UPDATE public.item_forward_events SET source_claim_id = NULL, source_kind = 'capture', source_capture_id = ev.search_result_id, confidence = 'medium' WHERE id = ev.event_id;
      END LOOP;
      INSERT INTO public.claim_versions (current_claim_id, intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason, version_number, supersede_reason, inaccuracy_proof, note, superseded_at)
      SELECT c.id, c.intelligence_item_id, c.section_row_id, c.claim_text, c.claim_kind, c.source_span, c.source_id, c.search_result_id, c.source_tier_at_grounding, c.mint_hold_reason,
             coalesce((SELECT max(version_number) FROM public.claim_versions v WHERE v.current_claim_id = c.id), 0) + 1,
             'orphaned_no_prose_referent', jsonb_build_object('reason', 'basis_claim_removed', 'section_key', s.section_key), NULL, coalesce(p_now, now())
        FROM public.section_claim_provenance c WHERE c.id = ANY (v_dep);
      GET DIAGNOSTICS n = ROW_COUNT;
      v_archived := v_archived + n;
      v_dep_claims := v_dep_claims + n;
      DELETE FROM public.section_claim_provenance WHERE id = ANY (v_dep);
    END IF;
    INSERT INTO public.claim_versions (current_claim_id, intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason, version_number, supersede_reason, inaccuracy_proof, note, superseded_at)
    SELECT c.id, c.intelligence_item_id, c.section_row_id, c.claim_text, c.claim_kind, c.source_span, c.source_id, c.search_result_id, c.source_tier_at_grounding, c.mint_hold_reason,
           coalesce((SELECT max(version_number) FROM public.claim_versions v WHERE v.current_claim_id = c.id), 0) + 1,
           'orphaned_no_prose_referent', jsonb_build_object('reason', 'section_removed', 'section_key', s.section_key), NULL, coalesce(p_now, now())
      FROM public.section_claim_provenance c WHERE c.section_row_id = s.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_archived := v_archived + n;
    DELETE FROM public.intelligence_item_sections WHERE id = s.id;
    v_removed := v_removed + 1;
  END LOOP;
  FOR s IN SELECT e ->> 'section_key' AS section_key, (e ->> 'section_order')::int AS section_order, e ->> 'content_md' AS content_md, coalesce((e ->> 'is_conditional')::boolean, false) AS is_conditional FROM jsonb_array_elements(p_sections) e LOOP
    UPDATE public.intelligence_item_sections SET section_order = s.section_order, content_md = s.content_md, is_conditional = s.is_conditional WHERE item_id = p_item_id AND section_key = s.section_key;
    IF FOUND THEN v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.intelligence_item_sections (item_id, section_key, section_order, content_md, is_conditional) VALUES (p_item_id, s.section_key, s.section_order, s.content_md, s.is_conditional);
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('removed', v_removed, 'claims_archived', v_archived, 'dependent_claims_archived', v_dep_claims, 'updated', v_updated, 'inserted', v_inserted);
END;
$$;

DO $$
DECLARE
  v_src uuid := gen_random_uuid(); v_item uuid := gen_random_uuid();
  v_keep uuid := gen_random_uuid(); v_gone_b uuid := gen_random_uuid(); v_gone_c uuid := gen_random_uuid();
  v_base uuid; v_dep_kept uuid; v_dep_later uuid; v_dep_chain uuid; r jsonb; n integer;
BEGIN
  BEGIN
    INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation) VALUES (v_src, 'selfcheck-0151', 'https://www.regulator-0151.invalid/rules', 1, 1);
    INSERT INTO public.intelligence_items (id, title, domain, source_id) VALUES (v_item, 'selfcheck 0151', 1, v_src);
    INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md) VALUES
      (v_keep, v_item, 'keep_0151', 1, 'kept'), (v_gone_b, v_item, 'gone_b_0151', 2, 'vanishing b'), (v_gone_c, v_item, 'gone_c_0151', 3, 'vanishing c');
    -- the basis lives in the first vanishing section; one dependent in a KEPT section, one in a section that goes LATER in the loop, one resting on that dependent (a chain)
    v_base := (public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_gone_b, 'claim_text', 'basis', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now()) ->> 'id')::uuid;
    v_dep_kept := (public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_keep, 'claim_text', 'dependent in a kept section', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now()) ->> 'id')::uuid;
    v_dep_later := (public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_gone_c, 'claim_text', 'dependent in a later vanishing section', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now()) ->> 'id')::uuid;
    v_dep_chain := (public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_keep, 'claim_text', 'rests on the dependent', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now()) ->> 'id')::uuid;
    UPDATE public.section_claim_provenance SET basis_claim_id = v_base WHERE id IN (v_dep_kept, v_dep_later);
    UPDATE public.section_claim_provenance SET basis_claim_id = v_dep_kept WHERE id = v_dep_chain;
    -- the attack: the reconcile that used to fail on the foreign key
    r := public.ledger_reconcile_sections(v_item, '[{"section_key":"keep_0151","section_order":1,"content_md":"kept v2","is_conditional":false}]'::jsonb, now());
    IF (r ->> 'removed')::int <> 2 OR (r ->> 'dependent_claims_archived')::int <> 3 OR (r ->> 'claims_archived')::int <> 4 THEN RAISE EXCEPTION '0151-reconcile-dependent-claims: reconcile gave %', r; END IF;
    IF EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE id IN (v_base, v_dep_kept, v_dep_later, v_dep_chain)) THEN RAISE EXCEPTION '0151-reconcile-dependent-claims: a claim that rests on a removed basis survived'; END IF;
    SELECT count(*) INTO n FROM public.claim_versions WHERE intelligence_item_id = v_item AND current_claim_id IN (v_base, v_dep_kept, v_dep_later, v_dep_chain) AND supersede_reason = 'orphaned_no_prose_referent';
    IF n <> 4 THEN RAISE EXCEPTION '0151-reconcile-dependent-claims: % of 4 removed claims archived', n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.intelligence_item_sections WHERE id = v_keep AND content_md = 'kept v2') OR EXISTS (SELECT 1 FROM public.intelligence_item_sections WHERE id IN (v_gone_b, v_gone_c)) THEN
      RAISE EXCEPTION '0151-reconcile-dependent-claims: the sections are not reconciled';
    END IF;
    -- a reconcile with no dependents is unchanged
    r := public.ledger_reconcile_sections(v_item, '[{"section_key":"keep_0151","section_order":1,"content_md":"kept v3","is_conditional":false}]'::jsonb, now());
    IF (r ->> 'removed')::int <> 0 OR (r ->> 'dependent_claims_archived')::int <> 0 OR (r ->> 'updated')::int <> 1 THEN RAISE EXCEPTION '0151-reconcile-dependent-claims: a plain reconcile gave %', r; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.ledger_reconcile_sections(uuid,jsonb,timestamptz)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.ledger_reconcile_sections(uuid,jsonb,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ledger_reconcile_sections(uuid,jsonb,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '0151-reconcile-dependent-claims: the execute rights are wrong';
  END IF;
  RAISE NOTICE '0151-reconcile-dependent-claims OK';
END $$;

COMMIT;
