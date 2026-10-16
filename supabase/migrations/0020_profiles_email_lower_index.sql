-- 0020 case-insensitive e-mail index on profiles (P2-S3, owed by IMPROVEMENTS IMP-008).
--
-- The add-member handler found an account with ILIKE on profiles.email and escaped LIKE wildcards by hand; ILIKE cannot use a btree index,
-- so it scanned the table. The lookup becomes an equality on the lower-cased address, served by an index on lower(email):
--   * profiles_email_lower_idx: btree on lower(email). Not unique: this migration adds an index, it does not introduce a constraint that
--     the live data (not visible to CI) might already violate.
--   * profiles_by_email(p_email): the ids whose lower(email) equals lower(p_email). PostgREST cannot filter on an expression, so the
--     members PUT handler calls this instead of `.eq("lower(email)")`; equality, so no LIKE wildcard in an address can match another
--     account and none needs escaping. STABLE, SECURITY INVOKER, service_role only (the handler's service client reads profiles).
-- Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.profiles_by_email(text); DROP INDEX public.profiles_email_lower_idx.

-- catalog: index, function

BEGIN;

CREATE INDEX profiles_email_lower_idx ON public.profiles (lower(email));

CREATE FUNCTION public.profiles_by_email(p_email text) RETURNS TABLE(id uuid)
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  AS $$ SELECT p.id FROM public.profiles p WHERE lower(p.email) = lower(p_email) ORDER BY p.id $$;
REVOKE ALL ON FUNCTION public.profiles_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profiles_by_email(text) TO service_role;

-- Self-check 0020-email-lower: the index exists on lower(email), and the planner uses it for an equality on lower(email) (sequential scans
-- are switched off for the probe, so a missing or wrong index shows as a sequential scan and fails).
DO $$
DECLARE def text; plan text; line text; u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
BEGIN
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'profiles_email_lower_idx';
  IF def IS NULL THEN RAISE EXCEPTION '0020-email-lower: the index does not exist'; END IF;
  IF def NOT LIKE '%(lower(email))%' THEN RAISE EXCEPTION '0020-email-lower: wrong expression: %', def; END IF;
  IF def LIKE '%UNIQUE%' OR def LIKE '% WHERE %' THEN RAISE EXCEPTION '0020-email-lower: the index must be plain: %', def; END IF;
  SET LOCAL enable_seqscan = off;
  plan := '';
  FOR line IN EXECUTE 'EXPLAIN SELECT id FROM public.profiles WHERE lower(email) = ''selfcheck@invalid.example''' LOOP plan := plan || line || E'\n'; END LOOP;
  IF plan NOT LIKE '%profiles_email_lower_idx%' THEN RAISE EXCEPTION '0020-email-lower: the planner does not use the index: %', plan; END IF;
  -- Attack: the old predicate (ILIKE on the raw column) must NOT be served by it, which is why the handler changes with this migration.
  plan := '';
  FOR line IN EXECUTE 'EXPLAIN SELECT id FROM public.profiles WHERE email ILIKE ''selfcheck@invalid.example''' LOOP plan := plan || line || E'\n'; END LOOP;
  IF plan LIKE '%profiles_email_lower_idx%' THEN RAISE EXCEPTION '0020-email-lower: ILIKE on the raw column unexpectedly uses the index'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u1, 'Mixed.Case_0020@Invalid.example'), (u2, 'mixedXcase_0020@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (u1, 'Mixed.Case_0020@Invalid.example'), (u2, 'mixedXcase_0020@invalid.example');
    IF (SELECT array_agg(id) FROM public.profiles_by_email('mIXED.case_0020@invalid.EXAMPLE')) IS DISTINCT FROM ARRAY[u1] THEN
      RAISE EXCEPTION '0020-email-lower: a different-case address did not find exactly its account';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles_by_email('mixed%case_0020@invalid.example')) OR EXISTS (SELECT 1 FROM public.profiles_by_email('%')) THEN
      RAISE EXCEPTION '0020-email-lower: a LIKE wildcard matched an account';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles_by_email('nobody-0020@invalid.example')) THEN RAISE EXCEPTION '0020-email-lower: an unknown address matched'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.profiles_by_email(text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.profiles_by_email(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0020-email-lower: a client role can execute profiles_by_email';
  END IF;
  RAISE NOTICE '0020-email-lower OK';
END $$;

COMMIT;
