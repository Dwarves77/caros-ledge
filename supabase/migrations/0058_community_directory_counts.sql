-- 0058 community_directory_counts (P2-16, BUILD-PLAN section 4 ruling 5: the directory floor is k = 5; community-b register section 3 rank 10).
--
-- The peer-organisation directory read every row of `profiles` with the service role on every page view, counted a column the verify route never writes, and published a cell of one: one member's organisation type, region
-- and sector shown to every signed-in user. This aggregate reads the Community profile (community_member_profiles) and publishes a cell ONLY when it holds at least 5 distinct organisations; a smaller cell is not
-- returned at all (suppressed in SQL, so no client can print it).
--   community_directory_counts() -> (dimension, org_type, region, sector, members, verified_members)
--   dimension 'org_region': one row per (org_type, region); dimension 'sector': one row per sector. A member with no region or sector is counted under the empty string.
-- "Distinct organisations": each distinct organisation_key (a verified member's pseudonymous key) is one organisation; all members with no key together count as ONE, because nothing says whose they are. So five
-- unverified members of one company are never a publishable cell. `members` is the number of profiles in the cell and `verified_members` those with verified = true.
-- Security definer: the organisation key is not a column a client role can read, and the function needs it to count organisations; it returns aggregates only, never a key, a user id or a name. Executable by authenticated and service_role. Not applied to production before
-- the cutover window.
--
-- Reversal: DROP FUNCTION public.community_directory_counts().

-- catalog: function

BEGIN;

CREATE FUNCTION public.community_directory_counts() RETURNS TABLE(dimension text, org_type text, region text, sector text, members bigint, verified_members bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH p AS (SELECT c.org_type, coalesce(c.region, '') AS region, coalesce(c.sector, '') AS sector, c.verified, c.organisation_key FROM public.community_member_profiles c),
  orgs AS (SELECT 'org_region'::text AS dimension, p.org_type, p.region, ''::text AS sector, count(*) AS members, count(*) FILTER (WHERE p.verified) AS verified_members,
                  count(DISTINCT p.organisation_key) + (CASE WHEN count(*) FILTER (WHERE p.organisation_key IS NULL) > 0 THEN 1 ELSE 0 END) AS orgs
             FROM p GROUP BY p.org_type, p.region
           UNION ALL
           SELECT 'sector'::text, ''::text, ''::text, p.sector, count(*), count(*) FILTER (WHERE p.verified),
                  count(DISTINCT p.organisation_key) + (CASE WHEN count(*) FILTER (WHERE p.organisation_key IS NULL) > 0 THEN 1 ELSE 0 END)
             FROM p WHERE p.sector <> '' GROUP BY p.sector)
  SELECT o.dimension, o.org_type, o.region, o.sector, o.members, o.verified_members FROM orgs o WHERE o.orgs >= 5 ORDER BY o.dimension, o.members DESC, o.org_type, o.region, o.sector
$$;
REVOKE ALL ON FUNCTION public.community_directory_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.community_directory_counts() TO authenticated, service_role;
COMMENT ON FUNCTION public.community_directory_counts() IS 'Peer-organisation directory aggregates; a cell under 5 distinct organisations is not returned (P2-16 migration 0058, k = 5).';

-- Self-check 0058-directory-counts: anon cannot execute. A cell of five organisations (five distinct keys) is returned with its member and verified counts; a cell of FOUR organisations is not returned at all, in either dimension; six
-- members that share ONE organisation key are suppressed; five unverified members of an unknown company are suppressed (they count as one); a lone member is suppressed; and the rows never carry a user id or a name.
DO $$
DECLARE u uuid; k int; n int; r record;
BEGIN
  IF has_function_privilege('anon', 'public.community_directory_counts()', 'EXECUTE') THEN RAISE EXCEPTION '0058-directory-counts: anon can execute it'; END IF;
  BEGIN
    -- five organisations: forwarders in the EU, sector fine-art (five distinct keys, three verified)
    FOR k IN 1..5 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'a' || k || '-0058@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector, verified, verified_at, verification_method, organisation_key)
      VALUES (u, 'forwarder', 'EU', 'fine-art', k <= 3, CASE WHEN k <= 3 THEN now() END, CASE WHEN k <= 3 THEN 'corporate-email' END, 'key-a' || k);
    END LOOP;
    -- four organisations: carriers in the US, sector live-events
    FOR k IN 1..4 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'b' || k || '-0058@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector, verified, verified_at, verification_method, organisation_key)
      VALUES (u, 'carrier', 'US', 'live-events', true, now(), 'corporate-email', 'key-b' || k);
    END LOOP;
    -- six members of ONE organisation: shippers in the UK, sector automotive
    FOR k IN 1..6 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'c' || k || '-0058@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector, verified, verified_at, verification_method, organisation_key)
      VALUES (u, 'shipper', 'UK', 'automotive', true, now(), 'corporate-email', 'key-same');
    END LOOP;
    -- five unverified members of an unknown company: regulators in APAC, sector film-tv
    FOR k IN 1..5 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'd' || k || '-0058@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector) VALUES (u, 'regulator', 'APAC', 'film-tv');
    END LOOP;
    -- a lone member
    u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'e-0058@invalid.example');
    INSERT INTO public.community_member_profiles (user_id, org_type, region, sector) VALUES (u, 'analyst', 'HK', 'humanitarian');

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    SELECT count(*) INTO n FROM public.community_directory_counts();
    IF n <> 2 THEN RAISE EXCEPTION '0058-directory-counts: % cells returned, expected 2 (the five-organisation cell in both dimensions)', n; END IF;
    SELECT * INTO r FROM public.community_directory_counts() WHERE dimension = 'org_region';
    IF r.org_type <> 'forwarder' OR r.region <> 'EU' OR r.members <> 5 OR r.verified_members <> 3 THEN RAISE EXCEPTION '0058-directory-counts: the org/region cell is wrong: %', r; END IF;
    SELECT * INTO r FROM public.community_directory_counts() WHERE dimension = 'sector';
    IF r.sector <> 'fine-art' OR r.members <> 5 THEN RAISE EXCEPTION '0058-directory-counts: the sector cell is wrong: %', r; END IF;
    IF EXISTS (SELECT 1 FROM public.community_directory_counts() WHERE org_type = 'carrier' OR sector = 'live-events') THEN RAISE EXCEPTION '0058-directory-counts: a cell of four organisations was returned'; END IF;
    IF EXISTS (SELECT 1 FROM public.community_directory_counts() WHERE org_type IN ('shipper', 'regulator', 'analyst')) THEN RAISE EXCEPTION '0058-directory-counts: a cell with fewer than five distinct organisations was returned'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0058-directory-counts OK';
END $$;

COMMIT;
