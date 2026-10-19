-- 0073 self-check repairs (R1b, remediation G6; good-enough audit K:38, K:40, K:72, K:73, and the live-coupled clauses of K:20 in 0035 and 0058). No schema change.
--
-- Five self-checks of applied migrations could pass while the thing they guard was wrong. Applied files are never edited, so each is re-proved here, forward, as an attack that has to fail:
--   0022  the "half-open row" attack inserted a triager that did not exist and caught check_violation OR foreign_key_violation: with the CHECK removed the foreign key still refused it and the attack passed. Here the triager and
--         the resolver are REAL users, so only the CHECK can refuse, and only check_violation is accepted.
--   0060  attack 3 accepted 42501 OR 23514 for a member creating a verified profile for someone else: a CHECK could refuse before the policy was reached. Here the row satisfies every CHECK (verified, with its method, time and
--         key), so only the row-level policy or the column privilege can refuse it, and only 42501 is accepted.
--   0035  compared admin_attention_counts() with a count of the live untriaged rejections: vacuous on an empty database, racy on production. Here a fixture rejection moves the count by exactly one and triaging it moves it back.
--   0058  compared the count of ALL published directory cells with 2 and read single rows by dimension: it failed on production once five organisations shared a live cell. Here every cell is a sector only the fixture uses, so the
--         assertions hold whatever else the table holds.
--   0069  asserted `NOT (res->>'trigger_enabled')::boolean` on the result of the function it replaced: 0068's function has no such key, the expression is NULL, an IF on NULL does not fire, and the check passed
--         with 0069's CREATE OR REPLACE removed (the self-check mutant of selfcheck:0069 was green). Here the key must be present, and the function may not take the replica role to plant its fixture.
-- The fixtures are inserted inside a sub-transaction that a sentinel rolls back; every row is the file's own.
--
-- Reversal: supabase/migrations/down/0073.sql (nothing to undo: the file changes nothing).

-- catalog: none

BEGIN;

-- Self-check 0073-selfcheck-repairs: the four attacks above.
DO $$
DECLARE
  u uuid := gen_random_uuid(); item uuid; k int; n int; before_n int; rej uuid; r record;
  a1 uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); r2 jsonb;
BEGIN
  -- 0022: only the CHECKs can refuse these rows (the users exist, so the foreign keys are satisfied)
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u, 'selfcheck-0073-22@invalid.example');
    INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0073', 1) RETURNING id INTO item;
    BEGIN
      INSERT INTO public.ingest_rejections (raw_value, rejection_reason, triaged_by) VALUES ('selfcheck-0073-half', 'unparseable', u);
      RAISE EXCEPTION '0073-selfcheck-repairs: 0022: a triager with nothing triaged was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.pending_jurisdiction_review (intelligence_item_id, current_value, flagged_reason, resolved_by) VALUES (item, 'selfcheck-0073', 'continent', u);
      RAISE EXCEPTION '0073-selfcheck-repairs: 0022: a resolver with nothing resolved was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- 0060: a member writes a profile that satisfies every CHECK; the policy or the column privilege must refuse it with 42501
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (a1, 'a-0073-60@invalid.example'), (b1, 'b-0073-60@invalid.example');
    INSERT INTO public.profiles (id, email, display_name) VALUES (a1, 'a-0073-60@invalid.example', 'A'), (b1, 'b-0073-60@invalid.example', 'B');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', a1::text, true);
    BEGIN
      INSERT INTO public.community_member_profiles (user_id, org_type, verified, verified_at, verification_method, organisation_key) VALUES (b1, 'other', true, now(), 'corporate-email', 'selfcheck-forged');
      RAISE EXCEPTION '0073-selfcheck-repairs: 0060: a member created a verified profile for someone else';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    BEGIN
      INSERT INTO public.community_member_profiles (user_id, org_type, verified, verified_at, verification_method, organisation_key) VALUES (a1, 'other', true, now(), 'corporate-email', 'selfcheck-forged');
      RAISE EXCEPTION '0073-selfcheck-repairs: 0060: a member created their own verified profile';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- 0035: a fixture rejection moves the attention count by exactly one, and triaging it moves it back
  BEGIN
    SELECT c.ingest_rejections_untriaged INTO before_n FROM public.admin_attention_counts() c;
    INSERT INTO public.ingest_rejections (raw_value, rejection_reason) VALUES ('selfcheck-0073-35', 'unparseable') RETURNING id INTO rej;
    SELECT c.ingest_rejections_untriaged INTO n FROM public.admin_attention_counts() c;
    IF n <> before_n + 1 THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0035: one untriaged rejection moved the attention count from % to %', before_n, n; END IF;
    UPDATE public.ingest_rejections SET triage_action = 'discarded', triaged_at = now() WHERE id = rej;
    SELECT c.ingest_rejections_untriaged INTO n FROM public.admin_attention_counts() c;
    IF n <> before_n THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0035: triaging it left the attention count at % (was %)', n, before_n; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- 0058: sector cells only the fixture uses. Five organisations: published with their counts. Four: absent. Six members of one key: absent. Five unverified members of an unknown company: absent.
  BEGIN
    FOR k IN 1..5 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'a' || k || '-0073-58@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector, verified, verified_at, verification_method, organisation_key)
      VALUES (u, 'forwarder', 'EU', 'selfcheck-0073-five', k <= 3, CASE WHEN k <= 3 THEN now() END, CASE WHEN k <= 3 THEN 'corporate-email' END, 'sc73-a' || k);
    END LOOP;
    FOR k IN 1..4 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'b' || k || '-0073-58@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector, verified, verified_at, verification_method, organisation_key)
      VALUES (u, 'carrier', 'US', 'selfcheck-0073-four', true, now(), 'corporate-email', 'sc73-b' || k);
    END LOOP;
    FOR k IN 1..6 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'c' || k || '-0073-58@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector, verified, verified_at, verification_method, organisation_key)
      VALUES (u, 'shipper', 'UK', 'selfcheck-0073-one-key', true, now(), 'corporate-email', 'sc73-same');
    END LOOP;
    FOR k IN 1..5 LOOP
      u := gen_random_uuid(); INSERT INTO auth.users (id, email) VALUES (u, 'd' || k || '-0073-58@invalid.example');
      INSERT INTO public.community_member_profiles (user_id, org_type, region, sector) VALUES (u, 'regulator', 'APAC', 'selfcheck-0073-unknown');
    END LOOP;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    SELECT * INTO r FROM public.community_directory_counts() c WHERE c.dimension = 'sector' AND c.sector = 'selfcheck-0073-five';
    IF NOT FOUND THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0058: the cell of five organisations was not returned'; END IF;
    IF r.members <> 5 OR r.verified_members <> 3 THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0058: the five-organisation cell counts % members and % verified, expected 5 and 3', r.members, r.verified_members; END IF;
    SELECT count(*) INTO n FROM public.community_directory_counts() c WHERE c.sector IN ('selfcheck-0073-four', 'selfcheck-0073-one-key', 'selfcheck-0073-unknown');
    IF n <> 0 THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0058: % cell(s) with fewer than five distinct organisations were returned', n; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- 0069: the function reports trigger_enabled (a NULL in the old check's own condition read as no failure), and its body no longer plants its fixture under the replica role
  SELECT public.live_check_provenance_trigger() INTO r2;
  IF NOT (r2 ? 'trigger_enabled') THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0069: the live check does not report trigger_enabled: %', r2; END IF;
  IF pg_get_functiondef('public.live_check_provenance_trigger()'::regprocedure) LIKE '%session_replication_role%' THEN RAISE EXCEPTION '0073-selfcheck-repairs: 0069: the live check still plants its fixture under the replica role'; END IF;

  RAISE NOTICE '0073-selfcheck-repairs OK';
END $$;

COMMIT;
