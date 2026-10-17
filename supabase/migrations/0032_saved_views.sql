-- 0032 saved views (P2-10, IMP-064; operator ruling 2026-10-16: personal per user).
--
-- The old Saved searches were browser-only storage with recall parameters the list never read; the feature returns built right. A saved view is a list's own URL state (its filters, sort and window,
-- exactly what src/ui/list-surface/url-state.ts writes) under a name, kept per user: one table, one route (/api/saved-views), the same state the list already reads from its URL.
-- Columns: id, user_id (the owner; ON DELETE CASCADE with the account), surface (the list it belongs to), name (1 to 60 characters, unique per user and surface ignoring case and padding), query (the
-- serialised list state, at most 1,000 characters), created_at.
-- Access: RLS on. An authenticated user reads, inserts and deletes ONLY their own rows (the policies compare user_id with (select auth.uid())); nobody updates (a view is replaced by saving the name again
-- after deleting it); anon holds nothing; service_role holds all (the account-deletion and support paths).
-- Not applied to production before the cutover window (two-track policy: schema DDL ahead of its consumer is safe, nothing reads it yet).
--
-- Reversal: DROP TABLE public.saved_views.

-- catalog: column, relation, constraint, index, policy, acl

BEGIN;

CREATE TABLE public.saved_views (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  surface text NOT NULL,
  name text NOT NULL,
  query text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_views_surface_check CHECK (surface IN ('regulations', 'market', 'research', 'operations', 'watchlist')),
  CONSTRAINT saved_views_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT saved_views_query_check CHECK (length(query) <= 1000)
);

ALTER TABLE public.saved_views
  ADD CONSTRAINT saved_views_pkey PRIMARY KEY (id),
  ADD CONSTRAINT saved_views_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX saved_views_user_surface_name_idx ON public.saved_views (user_id, surface, lower(btrim(name)));

COMMENT ON TABLE public.saved_views IS
  'A user''s saved list views (P2-10 migration 0032, IMP-064): the list''s URL state under a name, personal per user. RLS: a user reads, inserts and deletes only their own rows.';

ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.saved_views FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.saved_views TO authenticated;
GRANT ALL ON TABLE public.saved_views TO service_role;
CREATE POLICY saved_views_select_own ON public.saved_views FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY saved_views_insert_own ON public.saved_views FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY saved_views_delete_own ON public.saved_views FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- Self-check 0032-saved-views: shape, key, cascade, and the attacks as `authenticated`: user B reads none of user A's rows, cannot delete them, cannot insert a row in A's name, cannot update;
-- a duplicate name (any case, any padding), an empty name and an unknown surface are refused; anon holds nothing.
DO $$
DECLARE ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'saved_views') <> 'created_at,id,name,query,surface,user_id' THEN
    RAISE EXCEPTION '0032-saved-views: unexpected columns';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'saved_views_pkey') <> 'PRIMARY KEY (id)' THEN
    RAISE EXCEPTION '0032-saved-views: primary key is not (id)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.saved_views'::regclass) THEN
    RAISE EXCEPTION '0032-saved-views: RLS is off';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.saved_views'::regclass AND contype = 'f') <> 'c' THEN
    RAISE EXCEPTION '0032-saved-views: user_id does not cascade';
  END IF;
  IF has_table_privilege('anon', 'public.saved_views', 'SELECT') OR has_table_privilege('authenticated', 'public.saved_views', 'UPDATE') OR NOT has_table_privilege('service_role', 'public.saved_views', 'INSERT') THEN
    RAISE EXCEPTION '0032-saved-views: unexpected privileges';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (ua, 'a-0032@invalid.example'), (ub, 'b-0032@invalid.example');
    INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (ua, 'regulations', 'Immediate EU', 'band=immediate&region=EU');
    BEGIN
      INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (ua, 'regulations', '  immediate eu ', 'band=action');
      RAISE EXCEPTION '0032-saved-views: a duplicate name was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (ua, 'regulations', '   ', 'band=action');
      RAISE EXCEPTION '0032-saved-views: an empty name was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (ua, 'nowhere', 'x', '');
      RAISE EXCEPTION '0032-saved-views: an unknown surface was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    SELECT count(*) INTO n FROM public.saved_views;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0032-saved-views: user B read % of user A rows', n; END IF;
    DELETE FROM public.saved_views;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0032-saved-views: user B deleted % of user A rows', n; END IF;
    BEGIN
      INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (ua, 'regulations', 'forged', 'band=action');
      RESET ROLE;
      RAISE EXCEPTION '0032-saved-views: user B inserted a row in user A name';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE public.saved_views SET name = 'renamed';
      RESET ROLE;
      RAISE EXCEPTION '0032-saved-views: an authenticated user updated a view';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (ub, 'regulations', 'Mine', 'band=action');
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    SELECT count(*) INTO n FROM public.saved_views;
    RESET ROLE;
    IF n <> 1 THEN RAISE EXCEPTION '0032-saved-views: user A reads % rows, expected 1 (own only)', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0032-saved-views OK';
END $$;

COMMIT;
