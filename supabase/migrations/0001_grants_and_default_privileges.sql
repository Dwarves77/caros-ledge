-- 0001 grants and default privileges (P2-S1, owed by register P1-11 schema.md section 8 "Changed": default privileges,
-- invoker writers, SEC-9 and the 30 identity policies; schema.md section 3 rank 2).
--
-- Forward change on top of supabase/schema.sql. Applied by scripts/ci/schema-apply.mjs on the empty Postgres 15.14 in CI.
-- NOT applied to production before the cutover window: the old tree serves production and a grant or policy change under it
-- is a live risk.
--
-- What it does, in order:
--   1. Default privileges: new tables, sequences and functions created by postgres grant NOTHING to anon,
--      authenticated or PUBLIC (functions: no PUBLIC EXECUTE). A new object needs an explicit grant. The supabase_admin defaults are
--      Supabase's own platform state and not ours to set: the linked connection is postgres, which is not a member of supabase_admin
--      (42501 "must be member of role"), and every object these migrations create is owned by postgres.
--   2. Sequences: anon loses ALL on the existing sequences.
--   3. SEC-9 (old migration 386, branch-only, never applied): anon keeps SELECT on exactly the 14 relations in the grant table
--      below and loses every privilege on every other relation (49 dead relations plus 29 whose only policy needs an identity).
--   4. The roles-{public} SELECT policies outside the grant table, which all need an authenticated identity, are rewritten
--      TO authenticated, service_role (SEC-7's convention) so policy and grant agree.
--   5. EXECUTE: trigger functions and invoker functions that write lose PUBLIC, anon and authenticated EXECUTE.
-- community_group_members keeps its roles-{public} policy and its anon grant: community_posts and community_thread_entities,
-- which anon reads by design, subquery it, and a subquery needs the invoker's table privilege (old migration 386 header).
--
-- Reversal: GRANT SELECT back on the listed relations to anon; ALTER POLICY ... TO public; ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... GRANT (the supabase_admin defaults are never touched, so there is nothing to restore for them).

-- catalog: acl, default_acl, policy, function

BEGIN;

-- 1. Default privileges.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- 2. Sequences.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- 3. The anon grant table (SEC-9). Every relation here has a SELECT policy that an unauthenticated request can satisfy.
CREATE TEMP TABLE _anon_grant_table (relname text PRIMARY KEY, why text NOT NULL) ON COMMIT DROP;
INSERT INTO _anon_grant_table VALUES
  ('community_groups', 'public-by-privacy groups'),
  ('community_posts', 'posts of public groups'),
  ('community_thread_entities', 'entities of public threads'),
  ('community_group_members', 'subqueried by the two community policies above'),
  ('intelligence_changes', 'changes of live items'),
  ('intelligence_item_sections', 'sections of live items'),
  ('intelligence_items', 'published items'),
  ('item_changelog', 'changelog of verified items'),
  ('item_cross_references', 'cross references of verified items'),
  ('item_disputes', 'disputes of verified items'),
  ('item_forward_events', 'forward events of live items'),
  ('item_supersessions', 'supersessions of verified items'),
  ('item_timelines', 'timelines of verified items'),
  ('obligations', 'obligations of live items');

DO $$
DECLARE r record; n_revoked int := 0;
BEGIN
  FOR r IN SELECT g.relname FROM _anon_grant_table g
           WHERE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = g.relname
                              AND p.cmd IN ('SELECT', 'ALL') AND (p.roles && ARRAY['public', 'anon']::name[]))
  LOOP
    RAISE EXCEPTION '0001 precondition: grant-table relation % has no SELECT policy applying to anon or public', r.relname;
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND c.relname NOT IN (SELECT relname FROM _anon_grant_table)
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon', r.rel);
    n_revoked := n_revoked + 1;
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN _anon_grant_table g ON g.relname = c.relname
           WHERE c.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon', r.rel);
    EXECUTE format('GRANT SELECT ON TABLE %s TO anon', r.rel);
  END LOOP;
  RAISE NOTICE '0001: anon privileges revoked on % relations; SELECT kept on % relations', n_revoked, (SELECT count(*) FROM _anon_grant_table);
END $$;

-- 4. Identity policies move TO authenticated, service_role. The keep list is the policies anon satisfies by design.
CREATE TEMP TABLE _public_policy_keep (policyname text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _public_policy_keep VALUES
  ('community_groups_select_public_or_member'), ('community_posts_select_inherits_group'),
  ('community_thread_entities_select_inherits_thread'), ('community_group_members_select_self_or_admin'),
  ('intelligence_changes_read'), ('intelligence_item_sections_read'), ('item_changelog_read'), ('item_cross_references_read'),
  ('item_disputes_read'), ('item_forward_events_read'), ('item_supersessions_read'), ('item_timelines_read'), ('obligations_read');

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
           WHERE schemaname = 'public' AND cmd = 'SELECT' AND roles = '{public}'
             AND policyname NOT IN (SELECT policyname FROM _public_policy_keep)
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I TO authenticated, service_role', r.policyname, r.schemaname, r.tablename);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0001: % identity policies rewritten TO authenticated, service_role', n;
END $$;

-- 5. EXECUTE. Trigger functions never need a caller privilege; invoker functions that write are service-role only.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
             AND (p.prorettype = 'trigger'::regtype
                  OR p.proname IN ('acquire_mutation_lease', 'heartbeat_mutation_lease', 'release_mutation_lease',
                                   'acquire_funded_pass_lock', 'heartbeat_funded_pass_lock', 'release_funded_pass_lock',
                                   'register_derived_value', 'register_inference_record', 'invalidate_dependents'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
  END LOOP;
END $$;

-- Self-check 0001-grants: each assertion is an attack as the real role, not a presence test.
DO $$
DECLARE r record; ok boolean; bad text := '';
BEGIN
  -- anon holds only SELECT, and only on the grant table.
  SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ') INTO bad
    FROM information_schema.role_table_grants
   WHERE grantee IN ('anon', 'PUBLIC') AND table_schema = 'public'
     AND NOT (privilege_type = 'SELECT' AND table_name IN (SELECT relname FROM _anon_grant_table));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0001-grants: anon/PUBLIC holds % beyond the grant table', bad; END IF;
  -- every grant-table relation answers anon without a privilege error (policy subqueries included).
  FOR r IN SELECT relname FROM _anon_grant_table LOOP
    BEGIN
      SET LOCAL ROLE anon;
      EXECUTE format('SELECT count(*) FROM public.%I', r.relname);
      RESET ROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE EXCEPTION '0001-grants: anon is refused on grant-table relation %', r.relname;
    END;
  END LOOP;
  -- every other relation refuses anon.
  FOR r IN SELECT c.oid::regclass AS rel, c.relname FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND c.relname NOT IN (SELECT relname FROM _anon_grant_table) LOOP
    ok := false;
    BEGIN
      SET LOCAL ROLE anon;
      EXECUTE format('SELECT 1 FROM %s LIMIT 1', r.rel);
      RESET ROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION '0001-grants: anon can read %', r.relname; END IF;
  END LOOP;
  -- no roles-{public} SELECT policy remains outside the keep list.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND cmd = 'SELECT' AND roles = '{public}'
               AND policyname NOT IN (SELECT policyname FROM _public_policy_keep)) THEN
    RAISE EXCEPTION '0001-grants: an identity policy still names PUBLIC';
  END IF;
  -- postgres's default privileges grant nothing to anon, authenticated or PUBLIC (supabase_admin's are the platform's, left as they are).
  IF EXISTS (SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
              WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
                AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))) THEN
    RAISE EXCEPTION '0001-grants: a default ACL still grants to anon, authenticated or PUBLIC';
  END IF;
  -- sequences: anon holds nothing.
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
              WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')) THEN
    RAISE EXCEPTION '0001-grants: anon still holds a sequence privilege';
  END IF;
  -- EXECUTE: no trigger function and no writing invoker function is callable by anon or authenticated.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
     AND (p.prorettype = 'trigger'::regtype OR p.proname IN ('acquire_mutation_lease', 'register_derived_value',
          'register_inference_record', 'invalidate_dependents'))
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0001-grants: EXECUTE still open on %', bad; END IF;
  RAISE NOTICE '0001-grants OK';
END $$;

COMMIT;
