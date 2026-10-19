-- Down for 0012_drop_function_reading_dropped_table: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
CREATE OR REPLACE FUNCTION public.reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text DEFAULT NULL::text, p_next_item_id text DEFAULT NULL::text, p_seed_item_ids text[] DEFAULT NULL::text[])
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_step    constant numeric := 1000;
  v_min_gap constant numeric := 0.000001;
  v_prev    numeric;
  v_next    numeric;
  v_pos     numeric;
  v_count   integer;
BEGIN
  IF p_user_id IS NULL OR p_list_key IS NULL OR p_item_id IS NULL THEN
    RAISE EXCEPTION 'reorder_user_list_item: user_id, list_key and item_id are required';
  END IF;

  IF p_item_id = p_prev_item_id OR p_item_id = p_next_item_id THEN
    RAISE EXCEPTION 'reorder_user_list_item: item_id may not equal prev_item_id or next_item_id';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_list_key));

  SELECT count(*) INTO v_count
    FROM user_list_order
   WHERE user_id = p_user_id AND list_key = p_list_key;

  IF v_count = 0 AND p_seed_item_ids IS NOT NULL AND array_length(p_seed_item_ids, 1) > 0 THEN
    INSERT INTO user_list_order (user_id, list_key, item_id, position)
    SELECT p_user_id, p_list_key, s.item_id, s.ord * v_step
      FROM unnest(p_seed_item_ids) WITH ORDINALITY AS s(item_id, ord)
    ON CONFLICT (user_id, list_key, item_id) DO NOTHING;
  END IF;

  SELECT position INTO v_prev
    FROM user_list_order
   WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_prev_item_id;

  SELECT position INTO v_next
    FROM user_list_order
   WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_next_item_id;

  IF v_prev IS NOT NULL AND v_next IS NOT NULL AND (v_next - v_prev) < v_min_gap THEN
    WITH ladder AS (
      SELECT id, row_number() OVER (ORDER BY position, item_id) AS rn
        FROM user_list_order
       WHERE user_id = p_user_id AND list_key = p_list_key
    )
    UPDATE user_list_order u
       SET position = ladder.rn * v_step,
           updated_at = now()
      FROM ladder
     WHERE u.id = ladder.id;

    SELECT position INTO v_prev
      FROM user_list_order
     WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_prev_item_id;
    SELECT position INTO v_next
      FROM user_list_order
     WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_next_item_id;
  END IF;

  IF v_prev IS NULL AND v_next IS NULL THEN
    SELECT coalesce(max(position), 0) + v_step INTO v_pos
      FROM user_list_order
     WHERE user_id = p_user_id AND list_key = p_list_key AND item_id <> p_item_id;
  ELSIF v_prev IS NULL THEN
    v_pos := v_next - v_step;
  ELSIF v_next IS NULL THEN
    v_pos := v_prev + v_step;
  ELSE
    v_pos := (v_prev + v_next) / 2;
  END IF;

  INSERT INTO user_list_order (user_id, list_key, item_id, position)
  VALUES (p_user_id, p_list_key, p_item_id, v_pos)
  ON CONFLICT (user_id, list_key, item_id)
  DO UPDATE SET position = EXCLUDED.position, updated_at = now();

  RETURN v_pos;
END;
$function$
;
REVOKE ALL ON FUNCTION public.reorder_user_list_item(uuid,text,text,text,text,text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reorder_user_list_item(uuid,text,text,text,text,text[]) TO "service_role";
