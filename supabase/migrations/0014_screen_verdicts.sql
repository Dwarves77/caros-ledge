-- 0014 screen_verdicts (P2-S2, owed by register P1-05 mint.md section 8 "screen verdicts" (the table that replaces
-- fsi-app/scripts/mint/reviewed-verdicts.json) and IMPROVEMENTS IMP-039).
--
-- One row per census id: the reviewed verdict that overrides only a rule's `ambiguous` (src/features/mint/screen.ts
-- loadReviewedVerdicts reads census_id, verdict, basis, reviewer). The 1,746 verdicts the old file carried load through the
-- data migration 0015; later rulings are written by the judgement-drain path through the service role.
-- Columns: census_id uuid primary key referencing census_worklist(id) ON DELETE CASCADE; verdict (on_vertical | off_vertical |
-- ambiguous); basis text not null (the ruling citation, the old file's `reason`); reviewer text; ruled_at timestamptz.
-- Access: RLS on. service_role writes (bypasses RLS, holds its grants). authenticated reads through one policy limited to
-- platform admins, as harness_runs. anon: nothing.
-- Indexes: the primary key serves loadReviewedVerdicts (ordered by census_id) and the per-row lookup; a partial index on the
-- ambiguous verdicts serves the report and the re-screen of expired ambiguous holds (IMP-039).
-- Not applied to production before the cutover window (two-track policy: schema DDL ahead of its consumer is safe, nothing reads it yet).
--
-- Reversal: DROP TABLE public.screen_verdicts.

-- catalog: column, relation, constraint, index, policy, acl

BEGIN;

CREATE TABLE public.screen_verdicts (
  census_id uuid NOT NULL,
  verdict text NOT NULL,
  basis text NOT NULL,
  reviewer text,
  ruled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screen_verdicts_verdict_check CHECK (verdict IN ('on_vertical', 'off_vertical', 'ambiguous')),
  CONSTRAINT screen_verdicts_basis_check CHECK (length(btrim(basis)) > 0)
);

ALTER TABLE public.screen_verdicts
  ADD CONSTRAINT screen_verdicts_pkey PRIMARY KEY (census_id),
  ADD CONSTRAINT screen_verdicts_census_id_fkey FOREIGN KEY (census_id) REFERENCES public.census_worklist(id) ON DELETE CASCADE;

CREATE INDEX screen_verdicts_ambiguous_idx ON public.screen_verdicts (ruled_at) WHERE verdict = 'ambiguous';

COMMENT ON TABLE public.screen_verdicts IS
  'Reviewed relevance-screen verdicts, one per census id (P2-S2 migration 0014). Overrides only a rule''s ambiguous verdict (src/features/mint/screen.ts). basis is the ruling citation. Written through the service role; read by platform admins.';

ALTER TABLE public.screen_verdicts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.screen_verdicts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.screen_verdicts TO authenticated;
GRANT ALL ON TABLE public.screen_verdicts TO service_role;
CREATE POLICY screen_verdicts_read_platform_admin ON public.screen_verdicts FOR SELECT TO authenticated
  USING ((SELECT public.is_platform_admin()));

-- Self-check 0014-screen-verdicts: shape, key, cascade, access, and attacks as `authenticated`: a non-admin reads nothing and
-- cannot write; a platform admin reads the row; a bad verdict and an empty basis are refused.
DO $$
DECLARE n int; w uuid := gen_random_uuid(); cid uuid; uid uuid := gen_random_uuid();
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'screen_verdicts') <> 'basis,census_id,reviewer,ruled_at,verdict' THEN
    RAISE EXCEPTION '0014-screen-verdicts: unexpected columns';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'screen_verdicts_pkey') <> 'PRIMARY KEY (census_id)' THEN
    RAISE EXCEPTION '0014-screen-verdicts: primary key is not (census_id)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.screen_verdicts'::regclass) THEN
    RAISE EXCEPTION '0014-screen-verdicts: RLS is off';
  END IF;
  IF has_table_privilege('anon', 'public.screen_verdicts', 'SELECT') OR has_table_privilege('authenticated', 'public.screen_verdicts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.screen_verdicts', 'UPDATE') OR has_table_privilege('authenticated', 'public.screen_verdicts', 'DELETE') THEN
    RAISE EXCEPTION '0014-screen-verdicts: anon reads or authenticated writes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.screen_verdicts', 'INSERT') THEN
    RAISE EXCEPTION '0014-screen-verdicts: service_role cannot write';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.screen_verdicts'::regclass AND contype = 'f') <> 'c' THEN
    RAISE EXCEPTION '0014-screen-verdicts: census_id does not cascade';
  END IF;
  -- census_worklist is append-only (no DELETE), so the attacks run in a sub-block that ends in a sentinel exception: the fixture rows roll back.
  BEGIN
    INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation) VALUES (w, 'selfcheck-0014', 'https://selfcheck.invalid/', 3, 3);
    INSERT INTO public.census_worklist (source_id, document_url, lane, created_by) VALUES (w, 'https://selfcheck.invalid/doc', 'A', 'selfcheck-0014')
      RETURNING id INTO cid;
    INSERT INTO public.screen_verdicts (census_id, verdict, basis, reviewer) VALUES (cid, 'ambiguous', 'selfcheck', 'selfcheck');
    BEGIN
      INSERT INTO public.screen_verdicts (census_id, verdict, basis) VALUES (cid, 'maybe', 'x');
      RAISE EXCEPTION '0014-screen-verdicts: a verdict outside the vocabulary was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.screen_verdicts (census_id, verdict, basis) VALUES (cid, 'on_vertical', '  ');
      RAISE EXCEPTION '0014-screen-verdicts: an empty basis was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0014@invalid.example');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.screen_verdicts;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0014-screen-verdicts: a non-admin read % rows', n; END IF;
    BEGIN
      INSERT INTO public.screen_verdicts (census_id, verdict, basis) VALUES (cid, 'on_vertical', 'forged');
      RAISE EXCEPTION '0014-screen-verdicts: a non-admin wrote a verdict';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    INSERT INTO public.profiles (id, email, is_platform_admin) VALUES (uid, 'selfcheck-0014@invalid.example', true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.screen_verdicts;
    RESET ROLE;
    IF n <> 1 THEN RAISE EXCEPTION '0014-screen-verdicts: a platform admin read % rows, expected 1', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0014-screen-verdicts OK';
END $$;

COMMIT;
