-- 0042 host_verdicts (P2-S4, IMP-054; WHY section 7; P2-08's wiring row producers.verdicts was owed to this slice).
--
-- A host the institution class table does not place can be placed by a committed verdict: a session reads the host and rules which CLASS of the table it belongs to (never a tier number: the tier is read from the
-- table, so a verdict mints no tier the table lacks). The verdicts lived in a committed batch file the registry loader read; they are now rows, read by loadHostVerdicts (src/core/sources) into the map the turn
-- hands to registerAndRate and the batch kit, and written by the host-verdicts batch kind.
--   host        primary key: the bare hostname as the class table normalises it (lower case, no www., no trailing dot).
--   class       one of the class names of src/core/sources/data/tier-contract.json; the CHECK is generated from that file (scripts/gen/host-class-check.mjs) and pinned by scripts/ci/checks/generator-pins.mjs.
--   reason      the evidence the verdict rests on.     batch_id  the batch that ruled it.     ruled_by  who ruled (the session lane).     ruled_at  when.
-- Access: RLS on. service_role writes; a platform admin reads (the is_platform_admin() pattern of 0014); nobody else. Not applied to production before the cutover window.
--
-- Reversal: DROP TABLE public.host_verdicts.

-- catalog: relation, column, constraint, index, policy, acl

BEGIN;

CREATE TABLE public.host_verdicts (
  host text NOT NULL,
  class text NOT NULL,
  reason text,
  batch_id text,
  ruled_by text,
  ruled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT host_verdicts_class_check CHECK (class IN ('academic', 'analysis', 'association', 'company', 'gov', 'intergov_analysis', 'lawfirm', 'legal', 'news', 'standards_body', 'verifier')),
  CONSTRAINT host_verdicts_host_check CHECK (host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND host !~ '^www\.' AND host !~ '\.\.')
);
ALTER TABLE public.host_verdicts ADD CONSTRAINT host_verdicts_pkey PRIMARY KEY (host);

COMMENT ON TABLE public.host_verdicts IS 'Committed host class verdicts (P2-S4 migration 0042): a host the class table does not place, ruled into one of its classes. Written through the service role by the host-verdicts batch kind; read by platform admins.';

ALTER TABLE public.host_verdicts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.host_verdicts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.host_verdicts TO authenticated;
GRANT ALL ON TABLE public.host_verdicts TO service_role;
CREATE POLICY host_verdicts_read_platform_admin ON public.host_verdicts FOR SELECT TO authenticated USING ((SELECT public.is_platform_admin()));

-- Self-check 0042-host-verdicts, in a fixture that rolls back: a verdict of a class in the table reads back as written; a class the table lacks, an upper-case host, a host with a scheme or a www. prefix, an empty host
-- and a second verdict for one host are each refused; THE ATTACK: as `authenticated` a non-admin reads nothing and cannot write, a platform admin reads the row; anon holds nothing.
DO $$
DECLARE uid uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'host_verdicts') <> 'batch_id,class,host,reason,ruled_at,ruled_by' THEN
    RAISE EXCEPTION '0042-host-verdicts: unexpected columns';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.host_verdicts'::regclass) THEN RAISE EXCEPTION '0042-host-verdicts: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.host_verdicts', 'SELECT') OR has_table_privilege('authenticated', 'public.host_verdicts', 'INSERT') OR has_table_privilege('authenticated', 'public.host_verdicts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.host_verdicts', 'DELETE') OR NOT has_table_privilege('service_role', 'public.host_verdicts', 'INSERT') THEN
    RAISE EXCEPTION '0042-host-verdicts: unexpected privileges';
  END IF;
  BEGIN
    INSERT INTO public.host_verdicts (host, class, reason, batch_id, ruled_by) VALUES ('unplaced.example', 'association', 'the maker''s trade body', 'host-verdicts-001', 'session-lane');
    IF (SELECT class || '|' || ruled_by FROM public.host_verdicts WHERE host = 'unplaced.example') <> 'association|session-lane' THEN RAISE EXCEPTION '0042-host-verdicts: the verdict did not read back as written'; END IF;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('a.example', 'tier-1'); RAISE EXCEPTION '0042-host-verdicts: a class the table lacks was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('Upper.Example', 'legal'); RAISE EXCEPTION '0042-host-verdicts: an upper-case host was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('https://scheme.example', 'legal'); RAISE EXCEPTION '0042-host-verdicts: a host with a scheme was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('www.prefix.example', 'legal'); RAISE EXCEPTION '0042-host-verdicts: a www. host was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('', 'legal'); RAISE EXCEPTION '0042-host-verdicts: an empty host was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('unplaced.example', 'news'); RAISE EXCEPTION '0042-host-verdicts: a second verdict for one host was accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0042@invalid.example');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.host_verdicts;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0042-host-verdicts: a non-admin read % verdicts', n; END IF;
    BEGIN INSERT INTO public.host_verdicts (host, class) VALUES ('forged.example', 'legal'); RESET ROLE; RAISE EXCEPTION '0042-host-verdicts: a non-admin wrote a verdict';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    INSERT INTO public.profiles (id, email, is_platform_admin) VALUES (uid, 'selfcheck-0042@invalid.example', true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.host_verdicts;
    RESET ROLE;
    IF n <> 1 THEN RAISE EXCEPTION '0042-host-verdicts: a platform admin read % verdicts, expected 1', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0042-host-verdicts OK';
END $$;

COMMIT;
