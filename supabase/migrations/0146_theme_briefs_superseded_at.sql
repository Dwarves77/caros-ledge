-- 0146 theme_briefs_superseded_at: a theme brief whose theme was dissolved is retired with a date, not deleted and not hidden in another column (THEME-CODE-1, ruling 58).
-- change: theme_briefs.superseded_at timestamptz NULL; apply_theme_brief clears it when it writes a fresh brief for a (returning) theme
--
-- Before: the corpus pass replaces connection_themes wholesale, so theme_briefs kept rows for themes that no longer exist and no path could say so; a reader matched such a row to a live theme by member overlap and showed a brief about a group that was gone.
-- After: superseded_at is NULL for a brief that explains a live theme and holds the retirement time for one that does not (the retire-orphan-theme-briefs op sets it by UPDATE, so the 0039 trigger keeps the prior row). No reader attaches a brief with superseded_at set.
-- apply_theme_brief is replaced with one change: its upsert sets superseded_at = NULL, so a fresh brief written for a theme id that returns is current, never invisible behind an old retirement.
-- Access: unchanged (column grants follow the table; the function stays executable by service_role only). Reversal: down/0146.sql restores the function and drops the column (the retirement dates are lost).

-- catalog: column, function

BEGIN;

ALTER TABLE public.theme_briefs ADD COLUMN superseded_at timestamptz;
COMMENT ON COLUMN public.theme_briefs.superseded_at IS 'Migration 0146. NULL while the brief explains a live theme; the retirement time once its theme dissolved (retire-orphan-theme-briefs). Readers attach only briefs where this is NULL; apply_theme_brief clears it on a fresh write.';

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
         generated_by = EXCLUDED.generated_by, sections = EXCLUDED.sections, claims = EXCLUDED.claims, member_ids = EXCLUDED.member_ids, superseded_at = NULL;
  RETURN jsonb_build_object('written', 1, 'member_count', cardinality(v_sorted), 'member_hash', v_live);
END;
$$;

-- Self-check 0146-theme-briefs-superseded-at: the column is a nullable timestamptz; the function is still service_role only. In a fixture that rolls back: a written brief has superseded_at NULL; retiring it by UPDATE sets the date and leaves
-- its prior row in theme_brief_versions (the 0039 trigger); THE ATTACK: a fresh apply_theme_brief for the same theme id (a theme that returned) clears the retirement, and the row is the new brief.
DO $$
DECLARE
  t uuid := gen_random_uuid(); i1 uuid := 'ffffffff-0000-4000-8000-000000000146'; i2 uuid := '00000000-0000-4000-8000-000000000146'; h text; v_msg text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'theme_briefs' AND column_name = 'superseded_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION '0146-theme-briefs-superseded-at: theme_briefs.superseded_at is not a nullable timestamptz';
  END IF;
  h := md5(i2::text || i1::text);
  BEGIN
    INSERT INTO public.connection_themes (id, member_ids, density, convergence) VALUES (t, ARRAY[i1, i2], 1, 1);
    PERFORM public.apply_theme_brief(t, h, 'First', 'body one', '{"connection":"x"}'::jsonb, '[]'::jsonb, 'batch-0146', now());
    IF (SELECT superseded_at FROM public.theme_briefs WHERE theme_id = t) IS NOT NULL THEN RAISE EXCEPTION '0146-theme-briefs-superseded-at: a fresh brief is born retired'; END IF;
    UPDATE public.theme_briefs SET superseded_at = now() WHERE theme_id = t;
    IF (SELECT superseded_at FROM public.theme_briefs WHERE theme_id = t) IS NULL OR (SELECT count(*) FROM public.theme_brief_versions WHERE theme_key = t::text) <> 1 THEN
      RAISE EXCEPTION '0146-theme-briefs-superseded-at: the retirement did not stick or the prior row was not kept';
    END IF;
    PERFORM public.apply_theme_brief(t, h, 'Second', 'body two', '{"connection":"y"}'::jsonb, '[]'::jsonb, 'batch-0146b', now());
    IF (SELECT superseded_at FROM public.theme_briefs WHERE theme_id = t) IS NOT NULL OR (SELECT title FROM public.theme_briefs WHERE theme_id = t) <> 'Second' THEN
      RAISE EXCEPTION '0146-theme-briefs-superseded-at: a fresh brief for a returning theme stayed retired';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0146-theme-briefs-superseded-at: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0146-theme-briefs-superseded-at: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '0146-theme-briefs-superseded-at: a client role can execute apply_theme_brief';
  END IF;
  RAISE NOTICE '0146-theme-briefs-superseded-at OK';
END $$;

COMMIT;
