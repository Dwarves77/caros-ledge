-- Down for 0146_theme_briefs_superseded_at: apply_theme_brief returns to its 0075 body and the column (with every retirement date) goes.
CREATE OR REPLACE FUNCTION public.apply_theme_brief(p_theme_id uuid, p_member_hash text, p_title text, p_brief_md text, p_sections jsonb, p_claims jsonb, p_generated_by text, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ids uuid[];
  v_sorted uuid[];
  v_live text;
BEGIN
  IF p_theme_id IS NULL OR coalesce(btrim(p_title), '') = '' OR coalesce(btrim(p_brief_md), '') = '' OR coalesce(btrim(p_generated_by), '') = '' THEN
    RAISE EXCEPTION 'a theme brief needs its theme, title, body and batch' USING ERRCODE = '22023';
  END IF;
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'object' OR p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'a theme brief carries its sections (object) and claims (array): the unstructured form is not accepted' USING ERRCODE = '22023';
  END IF;
  SELECT member_ids INTO v_ids FROM public.connection_themes WHERE id = p_theme_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'theme % does not exist in connection_themes (it may have dissolved since the bundle was fetched)', p_theme_id USING ERRCODE = 'P0002'; END IF;
  v_sorted := ARRAY(SELECT x FROM unnest(v_ids) x ORDER BY x::text COLLATE "C");
  v_live := md5(coalesce((SELECT string_agg(x::text, '' ORDER BY x::text COLLATE "C") FROM unnest(v_ids) x), ''));
  IF p_member_hash IS DISTINCT FROM v_live THEN
    RAISE EXCEPTION 'member_hash mismatch: authored against %, the live membership hashes to %', p_member_hash, v_live USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.theme_briefs (theme_id, member_hash, member_count, title, brief_md, generated_at, generated_by, sections, claims, member_ids)
  VALUES (p_theme_id, v_live, cardinality(v_sorted), btrim(p_title), p_brief_md, coalesce(p_now, now()), p_generated_by, p_sections, p_claims, v_sorted)
  ON CONFLICT (theme_id) DO UPDATE
     SET member_hash = EXCLUDED.member_hash, member_count = EXCLUDED.member_count, title = EXCLUDED.title, brief_md = EXCLUDED.brief_md, generated_at = EXCLUDED.generated_at,
         generated_by = EXCLUDED.generated_by, sections = EXCLUDED.sections, claims = EXCLUDED.claims, member_ids = EXCLUDED.member_ids;
  RETURN jsonb_build_object('written', 1, 'member_count', cardinality(v_sorted), 'member_hash', v_live);
END;
$$;

ALTER TABLE public.theme_briefs DROP COLUMN superseded_at;
