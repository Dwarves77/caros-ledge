-- Down for 0151_reconcile_dependent_claims: ledger_reconcile_sections returns to its 0074 body (a claim another claim rests on is not handled; the reconcile fails on the basis_claim_id foreign key as before).

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
  RETURN jsonb_build_object('removed', v_removed, 'claims_archived', v_archived, 'updated', v_updated, 'inserted', v_inserted);
END;
$$;

