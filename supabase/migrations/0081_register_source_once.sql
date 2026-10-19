-- 0081 register_source_once: the registry identity is the database's (R2c C8, register rows D:27, D:28, D:29, D:76).
--
-- registerSource read the whole registry, looked for an institution key in application code, then inserted: two workers registering one institution both passed the check and made two rows (sources.url has no unique index),
-- and four code paths birthed a source with different rules. The identity is now a column and an index:
--   sources.institution_key   the registry identity of the row (host, plus a path prefix on a shared government portal: src/core/sources/institution.ts institutionKey). Null on a row not yet keyed.
--   a UNIQUE index on institution_key where it is not null: two institutions on one host are two keys; one institution is one row whatever order two workers arrive in.
--   register_source_once(p_key, p_row): ONE statement inserts the row for the key or reports the row that holds it. The row is built from the named fields of p_row (a closed list; anything else in the object is ignored),
--   so the named birth profiles of src/core/sources/register.ts (class, growth, candidate, promoted) differ only in the values they pass. service_role only.
-- The rows that exist are keyed by backfillInstitutionKeys (src/core/sources/register.ts), which the classify-sources job calls: oldest row first, a second row of one key is reported and left unkeyed, never merged by code.
-- Access: RLS unchanged; the function is executable by service_role only. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.register_source_once(text, jsonb); DROP INDEX public.sources_institution_key_uniq; ALTER TABLE public.sources DROP COLUMN institution_key.

-- catalog: column, constraint, index, function

BEGIN;

ALTER TABLE public.sources ADD COLUMN institution_key text;
ALTER TABLE public.sources ADD CONSTRAINT sources_institution_key_check CHECK (institution_key IS NULL OR (btrim(institution_key) <> '' AND institution_key = lower(institution_key)));
CREATE UNIQUE INDEX sources_institution_key_uniq ON public.sources (institution_key) WHERE institution_key IS NOT NULL;
COMMENT ON COLUMN public.sources.institution_key IS 'The registry identity of the row (migration 0081): host, plus a path prefix on a shared government portal. Unique where not null; written by register_source_once and backfillInstitutionKeys.';

CREATE FUNCTION public.register_source_once(p_key text, p_row jsonb) RETURNS TABLE (r_source_id uuid, r_created boolean, r_status text)
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
DECLARE sid uuid;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' OR p_key <> lower(p_key) THEN RAISE EXCEPTION 'register_source_once: the institution key must be a non-empty lower-case key' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' OR coalesce(p_row ->> 'url', '') = '' OR (p_row ->> 'base_tier') IS NULL THEN RAISE EXCEPTION 'register_source_once: the row needs a url and a base_tier' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.sources AS s (name, url, base_tier, tier_at_creation, effective_tier, status, admin_only, source_role, description, domains, jurisdictions, transport_modes, access_method, update_frequency, intelligence_types, vertical_tags, topic_tags, auto_run_enabled, notes, reuse_terms, institution_key)
  VALUES (
    coalesce(p_row ->> 'name', p_row ->> 'url'), p_row ->> 'url', (p_row ->> 'base_tier')::integer, coalesce((p_row ->> 'tier_at_creation')::integer, (p_row ->> 'base_tier')::integer), (p_row ->> 'effective_tier')::integer,
    coalesce(p_row ->> 'status', 'active'), coalesce((p_row ->> 'admin_only')::boolean, false), p_row ->> 'source_role', coalesce(p_row ->> 'description', ''),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'domains'))::integer[], '{}'::integer[]), coalesce(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'jurisdictions')), '{}'::text[]),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'transport_modes')), '{}'::text[]), coalesce(p_row ->> 'access_method', 'manual'), coalesce(p_row ->> 'update_frequency', 'weekly'),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'intelligence_types')), '{}'::text[]), coalesce(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'vertical_tags')), '{}'::text[]),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'topic_tags')), '{}'::text[]), coalesce((p_row ->> 'auto_run_enabled')::boolean, true), coalesce(p_row ->> 'notes', ''), coalesce(p_row ->> 'reuse_terms', 'unknown'), p_key)
  ON CONFLICT (institution_key) WHERE institution_key IS NOT NULL DO NOTHING
  RETURNING s.id INTO sid;
  IF sid IS NOT NULL THEN
    RETURN QUERY SELECT sid, true, (SELECT x.status FROM public.sources x WHERE x.id = sid);
  ELSE
    RETURN QUERY SELECT x.id, false, x.status FROM public.sources x WHERE x.institution_key = p_key;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.register_source_once(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_source_once(text, jsonb) TO service_role;

-- Self-check 0081-register-source-once, in a fixture that rolls back: THE ATTACK ON TWO WORKERS: a second call for one key returns the first row and creates nothing (one row for the key); THE ATTACK ON TWO INSTITUTIONS ON ONE HOST: two
-- keys on one host make two rows, each with its own tier; THE ATTACK ON THE KEY: an empty key, an upper-case key and a row with no tier are refused; THE ATTACK ON THE DUPLICATE: a second row carrying an existing key is refused by the
-- index; THE ATTACK ON ACCESS: neither anon nor authenticated can execute the function, service_role can.
DO $$
DECLARE a uuid; b uuid; c uuid; made boolean; n int;
BEGIN
  IF has_function_privilege('anon', 'public.register_source_once(text,jsonb)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.register_source_once(text,jsonb)', 'EXECUTE') OR NOT has_function_privilege('service_role', 'public.register_source_once(text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0081-register-source-once: unexpected privileges';
  END IF;
  BEGIN
    SELECT r_source_id, r_created INTO a, made FROM public.register_source_once('selfcheck-0081.invalid/ministry-a', '{"url":"https://selfcheck-0081.invalid/ministry-a/rules","base_tier":2,"name":"Ministry A"}'::jsonb);
    IF a IS NULL OR NOT made THEN RAISE EXCEPTION '0081-register-source-once: the first call did not create the row'; END IF;
    SELECT r_source_id, r_created INTO b, made FROM public.register_source_once('selfcheck-0081.invalid/ministry-a', '{"url":"https://selfcheck-0081.invalid/ministry-a/other","base_tier":5,"name":"Ministry A again"}'::jsonb);
    IF b <> a OR made THEN RAISE EXCEPTION '0081-register-source-once: a second call for one key did not return the first row'; END IF;
    SELECT r_source_id, r_created INTO c, made FROM public.register_source_once('selfcheck-0081.invalid/ministry-b', '{"url":"https://selfcheck-0081.invalid/ministry-b/rules","base_tier":6,"name":"Ministry B"}'::jsonb);
    IF c = a OR NOT made THEN RAISE EXCEPTION '0081-register-source-once: two institutions on one host did not make two rows'; END IF;
    SELECT count(*) INTO n FROM public.sources WHERE url LIKE 'https://selfcheck-0081.invalid/%';
    IF n <> 2 THEN RAISE EXCEPTION '0081-register-source-once: % rows for two institutions, expected 2', n; END IF;
    IF (SELECT base_tier FROM public.sources WHERE id = a) <> 2 OR (SELECT base_tier FROM public.sources WHERE id = c) <> 6 THEN RAISE EXCEPTION '0081-register-source-once: an institution took another institution tier'; END IF;
    BEGIN PERFORM public.register_source_once('', '{"url":"https://selfcheck-0081.invalid/x","base_tier":2}'::jsonb); RAISE EXCEPTION '0081-register-source-once: an empty key was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.register_source_once('Selfcheck-0081.Invalid', '{"url":"https://selfcheck-0081.invalid/x","base_tier":2}'::jsonb); RAISE EXCEPTION '0081-register-source-once: an upper-case key was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.register_source_once('selfcheck-0081.invalid/ministry-c', '{"url":"https://selfcheck-0081.invalid/ministry-c"}'::jsonb); RAISE EXCEPTION '0081-register-source-once: a row with no tier was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN INSERT INTO public.sources (name, url, base_tier, tier_at_creation, institution_key) VALUES ('dup', 'https://selfcheck-0081.invalid/dup', 2, 2, 'selfcheck-0081.invalid/ministry-a'); RAISE EXCEPTION '0081-register-source-once: a second row with an existing key was accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0081-register-source-once OK';
END $$;

COMMIT;
