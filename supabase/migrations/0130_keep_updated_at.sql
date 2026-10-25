-- 0130 keep_updated_at: a ledger write can leave updated_at as it was (MINT-1).
--
-- Before: the BEFORE UPDATE trigger update_updated_at() stamps NOW() on every update of every table that carries it, and overrides any updated_at the statement sets, so no writer could rewrite a stored line without
-- moving the item's updated_at: the lists' "last updated" figure (MAX(updated_at) in the counts functions), the impact scorer's staleness test (computed_at < updated_at) and the heal sweep's order all read it.
-- MINT-1 rewrites 1,547 stub items' absence lines to a token; a token rewrite is not an update a customer should see.
-- After: update_updated_at() keeps OLD.updated_at while the transaction-local setting app.keep_updated_at is 'on', and stamps NOW() otherwise (every other writer is unchanged). ledger_apply_ops sets that setting per op from the
-- op's `keep_updated_at: true` (any op kind) and turns it off when the list ends, so the one transaction that rewrites the lines is the only place it is ever on.
-- Access: unchanged (CREATE OR REPLACE keeps the grants; ledger_apply_ops stays executable by service_role only).
--
-- Reversal: down/0130.sql restores the two previous bodies (0074's ledger_apply_ops and the original update_updated_at).

-- catalog: function

BEGIN;

CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF current_setting('app.keep_updated_at', true) = 'on' THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.ledger_apply_ops(p_item_id uuid, p_ops jsonb, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  o jsonb;
  kind text;
  v_claims integer := 0;
  v_removed integer := 0;
  v_sections integer := 0;
BEGIN
  IF p_item_id IS NULL OR p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'ledger_apply_ops needs an item and an ops array' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item % not found', p_item_id USING ERRCODE = 'P0002'; END IF;
  FOR o IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    kind := o ->> 'op';
    -- 0130: an op that says keep_updated_at leaves updated_at as it was (a rewrite of how a stored line is written is not an update a reader should see); the setting is this transaction's, per op
    PERFORM set_config('app.keep_updated_at', CASE WHEN coalesce((o ->> 'keep_updated_at')::boolean, false) THEN 'on' ELSE 'off' END, true);
    IF kind = 'claim' THEN
      PERFORM public.ledger_write_claim(p_item_id, (o ->> 'claim_id')::uuid, o -> 'row', coalesce(o ->> 'reason', 'changed'), o ->> 'note', p_now);
      v_claims := v_claims + 1;
    ELSIF kind = 'remove' THEN
      PERFORM public.ledger_remove_claim((o ->> 'claim_id')::uuid, o ->> 'reason', o -> 'proof', o ->> 'note', p_now);
      v_removed := v_removed + 1;
    ELSIF kind = 'section_insert' THEN
      INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md, is_conditional)
      VALUES ((o ->> 'id')::uuid, p_item_id, o ->> 'section_key', (o ->> 'section_order')::int, o ->> 'content_md', coalesce((o ->> 'is_conditional')::boolean, false));
      v_sections := v_sections + 1;
    ELSIF kind = 'section_content' THEN
      UPDATE public.intelligence_item_sections SET content_md = o ->> 'content_md' WHERE id = (o ->> 'id')::uuid AND item_id = p_item_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'section % of item % not found', o ->> 'id', p_item_id USING ERRCODE = 'P0002'; END IF;
      v_sections := v_sections + 1;
    ELSIF kind = 'brief' THEN
      UPDATE public.intelligence_items SET full_brief = o ->> 'full_brief' WHERE id = p_item_id;
    ELSE
      RAISE EXCEPTION 'unknown ledger op %', kind USING ERRCODE = '22023';
    END IF;
  END LOOP;
  PERFORM set_config('app.keep_updated_at', 'off', true);
  RETURN jsonb_build_object('claims', v_claims, 'removed', v_removed, 'sections', v_sections);
END;
$$;

-- Self-check 0130-keep-updated-at: an update stamps updated_at; the same update under app.keep_updated_at = on keeps it; a ledger_apply_ops brief op with keep_updated_at keeps it and one without stamps it, and the setting is off after the call.
DO $$
DECLARE
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_old timestamptz := '2020-01-01T00:00:00Z';
BEGIN
  BEGIN
    -- an insert stamps NOW() through the status trigger's own update of the new row, so the fixture is inserted with the setting on: that update keeps the old stamp, and the plain update below is then visibly a stamp
    PERFORM set_config('app.keep_updated_at', 'on', true);
    INSERT INTO public.intelligence_items (id, title, domain, updated_at) VALUES (v_a, 'selfcheck 0130 a', 1, v_old), (v_b, 'selfcheck 0130 b', 1, v_old), (v_c, 'selfcheck 0130 c', 1, v_old);
    PERFORM set_config('app.keep_updated_at', 'off', true);
    IF (SELECT count(*) FROM public.intelligence_items WHERE id IN (v_a, v_b, v_c) AND updated_at = v_old) <> 3 THEN RAISE EXCEPTION '0130-keep-updated-at: the fixture rows did not keep their old updated_at under the setting'; END IF;
    UPDATE public.intelligence_items SET title = 'selfcheck 0130 a2' WHERE id = v_a;
    IF (SELECT updated_at FROM public.intelligence_items WHERE id = v_a) = v_old THEN RAISE EXCEPTION '0130-keep-updated-at: a plain update did not stamp updated_at'; END IF;
    PERFORM set_config('app.keep_updated_at', 'on', true);
    UPDATE public.intelligence_items SET title = 'selfcheck 0130 b2' WHERE id = v_b;
    PERFORM set_config('app.keep_updated_at', 'off', true);
    IF (SELECT updated_at FROM public.intelligence_items WHERE id = v_b) <> v_old THEN RAISE EXCEPTION '0130-keep-updated-at: an update under app.keep_updated_at = on moved updated_at'; END IF;
    PERFORM public.ledger_apply_ops(v_b, jsonb_build_array(jsonb_build_object('op', 'brief', 'full_brief', 'kept', 'keep_updated_at', true)), now());
    IF (SELECT updated_at FROM public.intelligence_items WHERE id = v_b) <> v_old OR (SELECT full_brief FROM public.intelligence_items WHERE id = v_b) <> 'kept' THEN RAISE EXCEPTION '0130-keep-updated-at: a brief op with keep_updated_at moved updated_at or did not write'; END IF;
    IF coalesce(current_setting('app.keep_updated_at', true), 'off') <> 'off' THEN RAISE EXCEPTION '0130-keep-updated-at: the setting stayed on after the call'; END IF;
    PERFORM public.ledger_apply_ops(v_c, jsonb_build_array(jsonb_build_object('op', 'brief', 'full_brief', 'stamped')), now());
    IF (SELECT updated_at FROM public.intelligence_items WHERE id = v_c) = v_old THEN RAISE EXCEPTION '0130-keep-updated-at: a brief op without the flag did not stamp updated_at'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0130-keep-updated-at OK';
END $$;

COMMIT;
