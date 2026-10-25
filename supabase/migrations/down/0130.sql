-- down/0130.sql: reverses 0130_keep_updated_at.sql. The two functions return to their previous bodies (update_updated_at as in supabase/schema.sql; ledger_apply_ops as 0074 created it).
CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
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
  RETURN jsonb_build_object('claims', v_claims, 'removed', v_removed, 'sections', v_sections);
END;
$$;
