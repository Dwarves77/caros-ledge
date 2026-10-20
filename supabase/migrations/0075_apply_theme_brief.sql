-- 0075 apply_theme_brief (R2b, MASTER I6; register F:3). One transaction for one theme brief.
--
-- The seam read the theme's live members, compared the author's member_hash, then upserted theme_briefs in a second statement: a theme replaced between the two (the corpus pass rewrites connection_themes) was
-- written against a membership that no longer existed (check then act). The function locks the theme row FOR SHARE (a replace of the theme waits for this commit), recomputes the member hash in SQL from the
-- locked row (md5 of the sorted member ids joined with nothing, the hash the application computes), refuses a mismatch, and upserts in the same statement sequence. The AFTER UPDATE trigger of 0039 keeps the
-- replaced row in theme_brief_versions in the same transaction, so the prior brief is archived first by construction. A dissolved theme answers P0002, a stale hash 22023.
--   apply_theme_brief(theme_id, member_hash, title, brief_md, sections, claims, generated_by, now) -> jsonb { written, member_count, member_hash }
-- Executable by service_role only: the caller is the theme-briefs apply, after it validated the entry (the application accepts nothing else). Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz).

-- catalog: function

BEGIN;

CREATE FUNCTION public.apply_theme_brief(p_theme_id uuid, p_member_hash text, p_title text, p_brief_md text, p_sections jsonb, p_claims jsonb, p_generated_by text, p_now timestamptz) RETURNS jsonb
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

REVOKE ALL ON FUNCTION public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz) TO service_role;
COMMENT ON FUNCTION public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz) IS 'Write one validated theme brief against the locked live membership in one transaction (R2b 0075, F:3): a stale hash or a dissolved theme writes nothing; the replaced row is kept by the 0039 trigger.';

-- Self-check 0075-apply-theme-brief: a brief for a live theme is written with the sorted member ids; a stale hash, a dissolved theme and an unstructured brief (no sections or claims) write nothing; a rewrite leaves the
-- prior row in theme_brief_versions in the same transaction; an INJECTED failure on the upsert leaves the prior brief and its history exactly as they were; a client role cannot execute the function.
DO $$
DECLARE
  t uuid := gen_random_uuid(); i1 uuid := 'ffffffff-0000-4000-8000-000000000071'; i2 uuid := '00000000-0000-4000-8000-000000000071';
  h text; r jsonb; n int; before_v int; v_msg text;
BEGIN
  h := md5(i2::text || i1::text);
  BEGIN
    INSERT INTO public.connection_themes (id, member_ids, density, convergence) VALUES (t, ARRAY[i1, i2], 1, 1);
    BEGIN PERFORM public.apply_theme_brief(t, 'deadbeef', 'T', 'body', '{}'::jsonb, '[]'::jsonb, 'batch-0075', now()); RAISE EXCEPTION '0075-apply-theme-brief: a stale hash was written';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.apply_theme_brief(gen_random_uuid(), h, 'T', 'body', '{}'::jsonb, '[]'::jsonb, 'batch-0075', now()); RAISE EXCEPTION '0075-apply-theme-brief: a dissolved theme was written';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    BEGIN PERFORM public.apply_theme_brief(t, h, 'T', 'body', NULL, NULL, 'batch-0075', now()); RAISE EXCEPTION '0075-apply-theme-brief: an unstructured brief was written';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    IF EXISTS (SELECT 1 FROM public.theme_briefs WHERE theme_id = t) THEN RAISE EXCEPTION '0075-apply-theme-brief: a refused call left a row'; END IF;
    r := public.apply_theme_brief(t, h, 'First', 'body one', '{"connection":"x"}'::jsonb, '[]'::jsonb, 'batch-0075', now());
    IF (r ->> 'member_count')::int <> 2 OR (SELECT member_ids FROM public.theme_briefs WHERE theme_id = t) <> ARRAY[i2, i1] OR (SELECT member_hash FROM public.theme_briefs WHERE theme_id = t) <> h THEN
      RAISE EXCEPTION '0075-apply-theme-brief: the written row is wrong: %', r;
    END IF;
    PERFORM public.apply_theme_brief(t, h, 'Second', 'body two', '{"connection":"y"}'::jsonb, '[]'::jsonb, 'batch-0075b', now());
    IF (SELECT count(*) FROM public.theme_brief_versions WHERE theme_key = t::text) <> 1 OR (SELECT row ->> 'title' FROM public.theme_brief_versions WHERE theme_key = t::text AND version = 1) <> 'First' THEN
      RAISE EXCEPTION '0075-apply-theme-brief: the replaced brief was not kept';
    END IF;
    CREATE FUNCTION pg_temp.inject_0075() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.title = 'INJECT' THEN RAISE EXCEPTION 'injected 0075 failure' USING ERRCODE = 'P0044'; END IF; RETURN NEW; END $f$;
    CREATE TRIGGER inject_0075 BEFORE UPDATE ON public.theme_briefs FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_0075();
    SELECT count(*) INTO before_v FROM public.theme_brief_versions WHERE theme_key = t::text;
    BEGIN PERFORM public.apply_theme_brief(t, h, 'INJECT', 'body three', '{"connection":"z"}'::jsonb, '[]'::jsonb, 'batch-0075c', now()); RAISE EXCEPTION '0075-apply-theme-brief: the injected failure did not fire';
    EXCEPTION WHEN SQLSTATE 'P0044' THEN NULL; END;
    SELECT count(*) INTO n FROM public.theme_brief_versions WHERE theme_key = t::text;
    IF n <> before_v OR (SELECT title FROM public.theme_briefs WHERE theme_id = t) <> 'Second' THEN RAISE EXCEPTION '0075-apply-theme-brief: a failed apply left a partial write'; END IF;
    DROP TRIGGER inject_0075 ON public.theme_briefs;
    DROP FUNCTION pg_temp.inject_0075();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0075-apply-theme-brief: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0075-apply-theme-brief: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '0075-apply-theme-brief: a client role can execute apply_theme_brief';
  END IF;
  RAISE NOTICE '0075-apply-theme-brief OK';
END $$;

COMMIT;
