-- 0076 apply_staged_item_patch (R2b, MASTER I6; register D:36). The one door from a staged proposal to intelligence_items.
--
-- The staged-transit writer sent proposed_changes straight to intelligence_items for any allowlisted column: no vocabulary check, no date check, a date column written with nothing behind it. A staged row is transit
-- only; it reaches the item through this function and nowhere else:
--   apply_staged_item_patch(item, kind, patch, evidence, now) -> jsonb { columns }
--   * kind is update_item, status_change (the status column alone) or archive_item (the four archive columns); the patch is a non-empty object; every key is on the allowlist below (the application's
--     staged.json lists the same columns, and a test fails when the two differ); any other key refuses the whole patch.
--   * the values are typed by the column itself (jsonb_populate_record: a malformed date, array or boolean raises), and the table's CHECK constraints are the vocabulary (status, severity, priority, urgency tier, format).
--   * a SOURCE date (entry_into_force, compliance_deadline) is written only with evidence: evidence -> <column> = { capture_id, span }, the capture a pool row OF THIS ITEM and the span verbatim in it (criterion 3's own test).
--     Clearing a date to null needs none.
--   * the item row is locked, the update is one statement, a failure writes nothing.
-- Executable by service_role only. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.apply_staged_item_patch(uuid, text, jsonb, jsonb).

-- catalog: function

BEGIN;

CREATE FUNCTION public.apply_staged_item_patch(p_item_id uuid, p_kind text, p_patch jsonb, p_evidence jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  c_content constant text[] := ARRAY['title', 'summary', 'what_is_it', 'why_matters', 'key_data', 'operational_impact', 'open_questions', 'tags', 'entry_into_force', 'compliance_deadline', 'next_review_date', 'jurisdiction_iso', 'canonical_instrument_key', 'instrument_identifier', 'instrument_type'];
  c_book constant text[] := ARRAY['status', 'severity', 'confidence', 'priority', 'is_archived', 'archive_reason', 'archive_note', 'archived_date', 'replaced_by', 'urgency_tier', 'format_type', 'last_regenerated_at', 'regeneration_skill_version', 'sources_used', 'version_history', 'last_verified', 'added_date', 'created_at', 'updated_at', 'legacy_id'];
  c_archive constant text[] := ARRAY['is_archived', 'archive_reason', 'archive_note', 'archived_date'];
  c_source_dates constant text[] := ARRAY['entry_into_force', 'compliance_deadline'];
  k text;
  v_cap uuid;
  v_span text;
  v_set text;
  v_keys text[];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('update_item', 'status_change', 'archive_item') THEN
    RAISE EXCEPTION 'unknown staged kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'empty patch refused: nothing to write' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO v_keys FROM jsonb_object_keys(p_patch) AS key;
  FOREACH k IN ARRAY v_keys LOOP
    IF NOT (k = ANY (c_content) OR k = ANY (c_book)) THEN
      RAISE EXCEPTION 'column % is outside the allowlist', k USING ERRCODE = '22023';
    END IF;
    IF p_kind = 'status_change' AND k <> 'status' THEN RAISE EXCEPTION 'a status change writes the status column alone (got %)', k USING ERRCODE = '22023'; END IF;
    IF p_kind = 'archive_item' AND NOT (k = ANY (c_archive)) THEN RAISE EXCEPTION 'an archive writes the archive columns alone (got %)', k USING ERRCODE = '22023'; END IF;
  END LOOP;
  PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item % not found', p_item_id USING ERRCODE = 'P0002'; END IF;
  FOREACH k IN ARRAY c_source_dates LOOP
    IF p_patch ? k AND jsonb_typeof(p_patch -> k) <> 'null' THEN
      v_cap := CASE WHEN jsonb_typeof(p_evidence -> k -> 'capture_id') = 'string' THEN (p_evidence -> k ->> 'capture_id')::uuid END;
      v_span := p_evidence -> k ->> 'span';
      IF v_cap IS NULL OR coalesce(btrim(v_span), '') = '' OR NOT EXISTS (
           SELECT 1 FROM public.agent_run_searches a
            WHERE a.id = v_cap AND a.intelligence_item_id = p_item_id AND a.result_content IS NOT NULL AND position(lower(btrim(v_span)) IN lower(a.result_content)) > 0) THEN
        RAISE EXCEPTION 'date % has no verbatim span in a capture of this item', k USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;
  SELECT string_agg(format('%I = r.%I', key, key), ', ') INTO v_set FROM unnest(v_keys) AS key;
  EXECUTE format('UPDATE public.intelligence_items i SET %s FROM jsonb_populate_record(NULL::public.intelligence_items, $1) r WHERE i.id = $2', v_set) USING p_patch, p_item_id;
  RETURN jsonb_build_object('columns', to_jsonb(v_keys));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_staged_item_patch(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_staged_item_patch(uuid, text, jsonb, jsonb) TO service_role;
COMMENT ON FUNCTION public.apply_staged_item_patch(uuid, text, jsonb, jsonb) IS 'The one door from a staged proposal to intelligence_items (R2b 0076, D:36): allowlisted columns typed by the table, a source date only with a verbatim span in a capture of the item, one locked statement.';

-- Self-check 0076-staged-patch: a content patch writes only its columns; a column off the allowlist, an empty patch, a status change carrying another column and an archive carrying a content column all refuse and change
-- nothing; a status outside the table's vocabulary and a malformed date raise; a source date with no evidence, with evidence from another item's capture and with a span the capture lacks refuse, and with a verbatim span of
-- its own capture writes; clearing a date needs no evidence; a client role cannot execute the function.
DO $$
DECLARE
  v_item uuid := gen_random_uuid(); v_other uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid(); v_cap_other uuid := gen_random_uuid();
  r jsonb; v_msg text;
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0076', 1), (v_other, 'selfcheck 0076 other', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index) VALUES
      (v_cap, v_item, 'https://regulator-0076.invalid/a', 'The Regulation enters into force on 1 January 2027.', 0),
      (v_cap_other, v_other, 'https://regulator-0076.invalid/b', 'The Regulation enters into force on 1 January 2027.', 0);
    r := public.apply_staged_item_patch(v_item, 'update_item', '{"title":"A better title","tags":["a","b"]}'::jsonb, NULL);
    IF (SELECT title FROM public.intelligence_items WHERE id = v_item) <> 'A better title' OR (SELECT tags FROM public.intelligence_items WHERE id = v_item) <> ARRAY['a', 'b'] OR (SELECT title FROM public.intelligence_items WHERE id = v_other) <> 'selfcheck 0076 other' THEN
      RAISE EXCEPTION '0076-staged-patch: the content patch wrote the wrong rows or columns: %', r;
    END IF;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'update_item', '{"title":"x","provenance_status":"verified"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: a column off the allowlist was written';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'update_item', '{}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: an empty patch was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'status_change', '{"status":"in_force","title":"sneaky"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: a status change carried another column';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'archive_item', '{"is_archived":true,"title":"sneaky"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: an archive carried a content column';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'status_change', '{"status":"made_up"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: a status outside the vocabulary was written';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'update_item', '{"next_review_date":"not a date"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: a malformed date was written';
    EXCEPTION WHEN invalid_datetime_format THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'update_item', '{"entry_into_force":"2027-01-01"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: a source date was written with no evidence';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'update_item', jsonb_build_object('entry_into_force', '2027-01-01'), jsonb_build_object('entry_into_force', jsonb_build_object('capture_id', v_cap_other, 'span', 'enters into force on 1 January 2027'))); RAISE EXCEPTION '0076-staged-patch: another item''s capture backed a date';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_staged_item_patch(v_item, 'update_item', jsonb_build_object('entry_into_force', '2027-01-01'), jsonb_build_object('entry_into_force', jsonb_build_object('capture_id', v_cap, 'span', 'enters into force on 2 March 2030'))); RAISE EXCEPTION '0076-staged-patch: a span the capture lacks backed a date';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    IF (SELECT entry_into_force FROM public.intelligence_items WHERE id = v_item) IS NOT NULL THEN RAISE EXCEPTION '0076-staged-patch: a refused date patch left a value'; END IF;
    PERFORM public.apply_staged_item_patch(v_item, 'update_item', jsonb_build_object('entry_into_force', '2027-01-01'), jsonb_build_object('entry_into_force', jsonb_build_object('capture_id', v_cap, 'span', 'ENTERS INTO FORCE ON 1 JANUARY 2027')));
    IF (SELECT entry_into_force FROM public.intelligence_items WHERE id = v_item) <> '2027-01-01' THEN RAISE EXCEPTION '0076-staged-patch: the evidenced date was not written'; END IF;
    PERFORM public.apply_staged_item_patch(v_item, 'update_item', '{"entry_into_force":null}'::jsonb, NULL);
    IF (SELECT entry_into_force FROM public.intelligence_items WHERE id = v_item) IS NOT NULL THEN RAISE EXCEPTION '0076-staged-patch: clearing a date failed'; END IF;
    PERFORM public.apply_staged_item_patch(v_item, 'archive_item', '{"is_archived":true,"archive_reason":"duplicate"}'::jsonb, NULL);
    IF NOT (SELECT is_archived FROM public.intelligence_items WHERE id = v_item) THEN RAISE EXCEPTION '0076-staged-patch: the archive was not written'; END IF;
    BEGIN PERFORM public.apply_staged_item_patch(gen_random_uuid(), 'update_item', '{"title":"x"}'::jsonb, NULL); RAISE EXCEPTION '0076-staged-patch: a missing item was written';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0076-staged-patch: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0076-staged-patch: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'public.apply_staged_item_patch(uuid, text, jsonb, jsonb)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.apply_staged_item_patch(uuid, text, jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0076-staged-patch: a client role can execute apply_staged_item_patch';
  END IF;
  RAISE NOTICE '0076-staged-patch OK';
END $$;

COMMIT;
