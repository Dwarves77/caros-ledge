-- 0039 theme_brief_versions (P2-S4, IMP-075; WHY section 7; the prior-row snapshot the old tree kept in a file, P2-08b note).
--
-- A theme brief is rewritten in place (theme_briefs, one row per theme); the old tree kept the prior rows in a snapshot file so a regeneration could be compared with what it replaced. The history now lives where the
-- data lives: an AFTER UPDATE trigger on theme_briefs copies the OLD row into theme_brief_versions, so every writer of the table (the theme-briefs seam, an operator statement, a future path) leaves the history
-- behind and no application code has to remember to.
--   id uuid, theme_key text (theme_id as text: the key a drifted theme is found by), version int (1 for the first superseded row, ascending per theme), row jsonb (the whole OLD row),
--   generated_by text (the batch that wrote that row), written_at (when that row was written: OLD.generated_at), superseded_at (when it was replaced).
-- Access: RLS on. service_role writes (the trigger runs as a definer so a history row cannot be lost to a role without the grant); a platform admin reads (the is_platform_admin() pattern of 0014); nobody else.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP TRIGGER theme_briefs_keep_version ON public.theme_briefs; DROP FUNCTION public.theme_briefs_keep_version(); DROP TABLE public.theme_brief_versions.

-- catalog: relation, column, constraint, index, policy, trigger, function, acl

BEGIN;

CREATE TABLE public.theme_brief_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  theme_key text NOT NULL,
  version int NOT NULL,
  row jsonb NOT NULL,
  generated_by text,
  written_at timestamptz,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_brief_versions_theme_version_key UNIQUE (theme_key, version),
  CONSTRAINT theme_brief_versions_version_check CHECK (version >= 1),
  CONSTRAINT theme_brief_versions_row_object CHECK (jsonb_typeof(row) = 'object')
);
ALTER TABLE public.theme_brief_versions ADD CONSTRAINT theme_brief_versions_pkey PRIMARY KEY (id);

COMMENT ON TABLE public.theme_brief_versions IS 'The prior rows of theme_briefs, one per replacement (P2-S4 migration 0039): written by the theme_briefs_keep_version trigger, read by platform admins, written by nobody else.';

ALTER TABLE public.theme_brief_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.theme_brief_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.theme_brief_versions TO authenticated;
GRANT ALL ON TABLE public.theme_brief_versions TO service_role;
CREATE POLICY theme_brief_versions_read_platform_admin ON public.theme_brief_versions FOR SELECT TO authenticated USING ((SELECT public.is_platform_admin()));

CREATE FUNCTION public.theme_briefs_keep_version() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  INSERT INTO public.theme_brief_versions (theme_key, version, row, generated_by, written_at)
    VALUES (OLD.theme_id::text, coalesce((SELECT max(v.version) FROM public.theme_brief_versions v WHERE v.theme_key = OLD.theme_id::text), 0) + 1, to_jsonb(OLD), OLD.generated_by, OLD.generated_at);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.theme_briefs_keep_version() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER theme_briefs_keep_version AFTER UPDATE ON public.theme_briefs FOR EACH ROW EXECUTE FUNCTION public.theme_briefs_keep_version();

-- Self-check 0039-theme-brief-versions: shape and access, then in a fixture that rolls back: a brief updated twice leaves two versions in order, each the row as it was before that update (the first update's OLD is the
-- insert, the second's the first update); a different theme starts at version 1; the version number is unique per theme. THE ATTACK: as `authenticated` a non-admin reads nothing and cannot insert a version (no
-- grant), a platform admin reads them, and anon holds nothing.
DO $$
DECLARE t uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); uid uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'theme_brief_versions') <> 'generated_by,id,row,superseded_at,theme_key,version,written_at' THEN
    RAISE EXCEPTION '0039-theme-brief-versions: unexpected columns';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.theme_brief_versions'::regclass) THEN RAISE EXCEPTION '0039-theme-brief-versions: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.theme_brief_versions', 'SELECT') OR has_table_privilege('authenticated', 'public.theme_brief_versions', 'INSERT') OR has_table_privilege('authenticated', 'public.theme_brief_versions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.theme_brief_versions', 'DELETE') OR NOT has_table_privilege('service_role', 'public.theme_brief_versions', 'INSERT') THEN
    RAISE EXCEPTION '0039-theme-brief-versions: unexpected privileges';
  END IF;
  BEGIN
    INSERT INTO public.theme_briefs (theme_id, member_hash, member_count, title, brief_md, generated_by) VALUES (t, 'h1', 1, 'first', 'body one', 'batch-1'), (t2, 'h9', 1, 'other', 'body other', 'batch-9');
    UPDATE public.theme_briefs SET title = 'second', brief_md = 'body two', generated_by = 'batch-2' WHERE theme_id = t;
    UPDATE public.theme_briefs SET title = 'third', brief_md = 'body three', generated_by = 'batch-3' WHERE theme_id = t;
    IF (SELECT count(*) FROM public.theme_brief_versions WHERE theme_key = t::text) <> 2 THEN RAISE EXCEPTION '0039-theme-brief-versions: two updates did not leave two versions'; END IF;
    IF (SELECT row->>'title' FROM public.theme_brief_versions WHERE theme_key = t::text AND version = 1) <> 'first' OR (SELECT generated_by FROM public.theme_brief_versions WHERE theme_key = t::text AND version = 1) <> 'batch-1'
       OR (SELECT row->>'title' FROM public.theme_brief_versions WHERE theme_key = t::text AND version = 2) <> 'second' OR (SELECT row->>'brief_md' FROM public.theme_brief_versions WHERE theme_key = t::text AND version = 2) <> 'body two' THEN
      RAISE EXCEPTION '0039-theme-brief-versions: a version is not the row as it was before its update';
    END IF;
    IF (SELECT count(*) FROM public.theme_brief_versions WHERE theme_key = t2::text) <> 0 THEN RAISE EXCEPTION '0039-theme-brief-versions: an untouched theme has a version'; END IF;
    UPDATE public.theme_briefs SET title = 'other two' WHERE theme_id = t2;
    IF (SELECT max(version) FROM public.theme_brief_versions WHERE theme_key = t2::text) <> 1 THEN RAISE EXCEPTION '0039-theme-brief-versions: a second theme did not start at version 1'; END IF;
    BEGIN INSERT INTO public.theme_brief_versions (theme_key, version, row) VALUES (t::text, 1, '{}'); RAISE EXCEPTION '0039-theme-brief-versions: a version number repeated';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0039@invalid.example');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.theme_brief_versions;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0039-theme-brief-versions: a non-admin read % versions', n; END IF;
    BEGIN INSERT INTO public.theme_brief_versions (theme_key, version, row) VALUES (t::text, 9, '{}'); RESET ROLE; RAISE EXCEPTION '0039-theme-brief-versions: a member inserted a version';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    INSERT INTO public.profiles (id, email, is_platform_admin) VALUES (uid, 'selfcheck-0039@invalid.example', true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.theme_brief_versions WHERE theme_key = t::text;
    RESET ROLE;
    IF n <> 2 THEN RAISE EXCEPTION '0039-theme-brief-versions: a platform admin read % versions, expected 2', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0039-theme-brief-versions OK';
END $$;

COMMIT;
