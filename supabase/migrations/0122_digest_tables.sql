-- 0122 digest tables (DIGEST-1 PR A, D2): the judgement drain's switch and leases confirmed, the second reader's scores (brief_reviews) and the admin kind's findings (admin_opportunity_findings).
--
-- (a) The switch: system_state.judgement_drain, text, default 'off', CHECK in ('off', 'on'), written only through admin_set_judgement_drain behind the guard trigger (old migration 354). The baseline (schema.sql) and production
--     (information_schema, read-only, 2026-10-24) already carry the column, the CHECK, the guard and the writer, so the statement here is ADD COLUMN IF NOT EXISTS and changes nothing; the self-check proves the default and attacks the
--     guard on a fixture. The value on production is NOT touched by this file (the drain stays off until the operator accepts the sample set).
-- (b) The leases: mutation_leases (old migration 211), one live lease per item with stale takeover. The table exists in the baseline and on production; CREATE TABLE IF NOT EXISTS changes nothing, and the three functions
--     (acquire_mutation_lease, heartbeat_mutation_lease, release_mutation_lease) are asserted present. The self-check attacks them: a second holder is refused, a non-holder cannot release, the holder's release frees the item.
-- (c) brief_reviews: the second reader's score and reasons for a brief or finding (kind, the subject it scored, the batch it was scored in, score 0 to 1, reasons, whether it fell under the bar and became residue). A brief
--     under the bar is residue with its reasons and is not in the batch (DIGEST-1 D4); the row is the record of why. Written by the drain run as service_role; read by platform admins.
-- (d) admin_opportunity_findings: what the admin kind writes and /admin reads: one sourced finding per derived pattern, in one of three lenses and one of three windows, with its tagged inferences, the ids of its falsifiable
--     signposts in inference_records (an array cannot carry a foreign key, so the apply path refuses an unknown id), and claim_provenance (packet row ids and verbatim spans; the validator refuses an id outside the packet,
--     INV-CN2-4). RLS on; one policy, select to platform admins through public.is_platform_admin() (SEC-6, old migration 375); no policy for anon and none for authenticated writes; the apply path writes as service_role.
--     "window" is quoted because WINDOW is a reserved word. Two indexes beyond the brief's (lens, created_at desc) serve the foreign keys (the fk-indexed property) and the exporter's "no current finding" filter.
-- Access, both tables: RLS on, service_role writes, authenticated reads through the platform-admin policy, anon nothing.
--
-- Reversal: down/0122.sql drops the two tables; (a) and (b) existed before and are not undone.

-- catalog: column, relation, constraint, index, policy, acl

BEGIN;

ALTER TABLE public.system_state ADD COLUMN IF NOT EXISTS judgement_drain text NOT NULL DEFAULT 'off';

CREATE TABLE IF NOT EXISTS public.mutation_leases (
  intelligence_item_id uuid PRIMARY KEY,
  holder text NOT NULL,
  lane text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.brief_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  batch text NOT NULL,
  score numeric NOT NULL,
  reasons text NOT NULL,
  residue boolean NOT NULL DEFAULT false,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brief_reviews_kind_check CHECK (kind IN ('item-briefs', 'theme-briefs', 'admin-opportunity-findings')),
  CONSTRAINT brief_reviews_score_check CHECK (score >= 0 AND score <= 1),
  CONSTRAINT brief_reviews_one_per_batch UNIQUE (kind, subject_id, batch)
);

CREATE TABLE public.admin_opportunity_findings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lens text NOT NULL,
  "window" text NOT NULL,
  pattern_value_id uuid NOT NULL,
  title text NOT NULL,
  sourced_finding_md text NOT NULL,
  inferences jsonb NOT NULL,
  signpost_inference_ids uuid[] NOT NULL,
  claim_provenance jsonb NOT NULL,
  review_score numeric,
  review_reasons text,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_by uuid,
  CONSTRAINT admin_opportunity_findings_lens_check CHECK (lens IN ('supply_demand_bottleneck', 'penalty_abatement_crossover', 'capital_offtake_grant')),
  CONSTRAINT admin_opportunity_findings_window_check CHECK ("window" IN ('0-6m', '6-18m', '18-36m'))
);

ALTER TABLE public.brief_reviews ADD CONSTRAINT brief_reviews_pkey PRIMARY KEY (id);
ALTER TABLE public.admin_opportunity_findings
  ADD CONSTRAINT admin_opportunity_findings_pkey PRIMARY KEY (id),
  ADD CONSTRAINT admin_opportunity_findings_pattern_value_id_fkey FOREIGN KEY (pattern_value_id) REFERENCES public.derived_values (value_id),
  ADD CONSTRAINT admin_opportunity_findings_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.admin_opportunity_findings (id);

CREATE INDEX admin_opportunity_findings_lens_idx ON public.admin_opportunity_findings (lens, created_at DESC);
CREATE INDEX admin_opportunity_findings_pattern_idx ON public.admin_opportunity_findings (pattern_value_id);
CREATE INDEX admin_opportunity_findings_superseded_idx ON public.admin_opportunity_findings (superseded_by);

COMMENT ON TABLE public.brief_reviews IS
  'The second reader''s score and reasons for one brief or finding in one batch (DIGEST-1 migration 0122). A brief under the bar is residue (residue = true) and is not in the batch. Written by the drain run as service_role; read by platform admins.';
COMMENT ON TABLE public.admin_opportunity_findings IS
  'Admin-only findings of the digest (DIGEST-1 migration 0122): a sourced finding per derived pattern, a lens, a window, tagged inferences, the ids of its signposts in inference_records and its claim provenance. Platform admins read; the apply path writes as service_role; no customer route reads it.';

ALTER TABLE public.brief_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_opportunity_findings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.brief_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.admin_opportunity_findings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.brief_reviews TO authenticated;
GRANT SELECT ON TABLE public.admin_opportunity_findings TO authenticated;
GRANT ALL ON TABLE public.brief_reviews TO service_role;
GRANT ALL ON TABLE public.admin_opportunity_findings TO service_role;
CREATE POLICY brief_reviews_read_platform_admin ON public.brief_reviews FOR SELECT TO authenticated
  USING ((SELECT public.is_platform_admin()));
CREATE POLICY admin_opportunity_findings_read_platform_admin ON public.admin_opportunity_findings FOR SELECT TO authenticated
  USING ((SELECT public.is_platform_admin()));

-- Self-check 0122-digest-tables: (a) the switch defaults to off and its guard refuses an unmarked write (fixture table); (b) the lease functions exist and behave (second holder refused, non-holder cannot release, holder frees);
-- (c, d) shape, CHECKs, the foreign key, access, and attacks as `authenticated`: a customer session reads nothing from either table and cannot write (INV-DIG-8, database half); a platform admin reads the row.
DO $$
DECLARE
  n int;
  uid uuid := gen_random_uuid();
  pv uuid := gen_random_uuid();
  item uuid := gen_random_uuid();
  fid uuid;
BEGIN
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'system_state' AND column_name = 'judgement_drain') IS DISTINCT FROM '''off''::text' THEN
    RAISE EXCEPTION '0122-digest-tables: system_state.judgement_drain does not default to off';
  END IF;
  IF to_regprocedure('public.acquire_mutation_lease(uuid,text,text,integer)') IS NULL OR to_regprocedure('public.heartbeat_mutation_lease(uuid,text)') IS NULL OR to_regprocedure('public.release_mutation_lease(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '0122-digest-tables: a mutation lease function is missing';
  END IF;
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'brief_reviews')
       <> 'batch,id,kind,reasons,residue,reviewed_at,reviewed_by,score,subject_id' THEN
    RAISE EXCEPTION '0122-digest-tables: unexpected brief_reviews columns';
  END IF;
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_opportunity_findings')
       <> 'claim_provenance,created_at,id,inferences,lens,pattern_value_id,review_reasons,review_score,signpost_inference_ids,sourced_finding_md,superseded_by,title,window' THEN
    RAISE EXCEPTION '0122-digest-tables: unexpected admin_opportunity_findings columns';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_opportunity_findings'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.brief_reviews'::regclass) THEN
    RAISE EXCEPTION '0122-digest-tables: RLS is off';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_opportunity_findings') <> 1
     OR (SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_opportunity_findings') <> 'SELECT' THEN
    RAISE EXCEPTION '0122-digest-tables: admin_opportunity_findings must carry exactly one policy, a SELECT';
  END IF;
  IF has_table_privilege('anon', 'public.admin_opportunity_findings', 'SELECT') OR has_table_privilege('anon', 'public.brief_reviews', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admin_opportunity_findings', 'INSERT') OR has_table_privilege('authenticated', 'public.admin_opportunity_findings', 'UPDATE') OR has_table_privilege('authenticated', 'public.admin_opportunity_findings', 'DELETE')
     OR has_table_privilege('authenticated', 'public.brief_reviews', 'INSERT') OR has_table_privilege('authenticated', 'public.brief_reviews', 'UPDATE') OR has_table_privilege('authenticated', 'public.brief_reviews', 'DELETE') THEN
    RAISE EXCEPTION '0122-digest-tables: anon reads or authenticated writes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.admin_opportunity_findings', 'INSERT') OR NOT has_table_privilege('service_role', 'public.brief_reviews', 'INSERT') THEN
    RAISE EXCEPTION '0122-digest-tables: service_role cannot write';
  END IF;
  -- Everything below runs on fixtures inside a sub-block that ends in a sentinel exception, so no fixture row survives.
  BEGIN
    -- (a) the guard, on a fixture table carrying the real trigger function: an unmarked change to the switch is refused.
    CREATE TEMP TABLE sc_0122_switch (id boolean PRIMARY KEY DEFAULT true, judgement_drain text NOT NULL DEFAULT 'off') ON COMMIT DROP;
    INSERT INTO sc_0122_switch (id) VALUES (true);
    CREATE TRIGGER sc_0122_guard BEFORE UPDATE ON sc_0122_switch FOR EACH ROW EXECUTE FUNCTION public.guard_judgement_drain_writer();
    BEGIN
      UPDATE sc_0122_switch SET judgement_drain = 'on';
      RAISE EXCEPTION '0122-digest-tables: an unmarked write turned the drain switch on';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- (b) the leases.
    IF NOT (SELECT acquired FROM public.acquire_mutation_lease(item, 'sc-0122-a', 'judgement-drain', 10800)) THEN
      RAISE EXCEPTION '0122-digest-tables: the first holder was refused a free lease';
    END IF;
    IF (SELECT acquired FROM public.acquire_mutation_lease(item, 'sc-0122-b', 'judgement-drain', 10800)) THEN
      RAISE EXCEPTION '0122-digest-tables: a second holder took a live lease';
    END IF;
    IF (SELECT released FROM public.release_mutation_lease(item, 'sc-0122-b')) THEN
      RAISE EXCEPTION '0122-digest-tables: a non-holder released a lease';
    END IF;
    IF NOT (SELECT released FROM public.release_mutation_lease(item, 'sc-0122-a')) THEN
      RAISE EXCEPTION '0122-digest-tables: the holder could not release its lease';
    END IF;
    IF NOT (SELECT acquired FROM public.acquire_mutation_lease(item, 'sc-0122-b', 'judgement-drain', 10800)) THEN
      RAISE EXCEPTION '0122-digest-tables: a released item could not be leased again';
    END IF;
    -- (c, d) the tables.
    INSERT INTO public.derived_values (value_id, method_id, method_version, value, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_at, computed_by)
      VALUES (pv, 'selfcheck_0122', '1.0.0', 1, 'calculated', 'derived', 'verified', 'display_only', 0.5, now(), '[]'::jsonb, now(), 'selfcheck-0122');
    INSERT INTO public.admin_opportunity_findings (lens, "window", pattern_value_id, title, sourced_finding_md, inferences, signpost_inference_ids, claim_provenance)
      VALUES ('supply_demand_bottleneck', '0-6m', pv, 'selfcheck', 'a sourced finding', '[]'::jsonb, ARRAY[]::uuid[], '[]'::jsonb) RETURNING id INTO fid;
    INSERT INTO public.brief_reviews (kind, subject_id, batch, score, reasons, reviewed_by) VALUES ('admin-opportunity-findings', fid, 'admin-opportunity-findings-001', 0.8, 'sourced from two tables', 'selfcheck-0122');
    BEGIN
      INSERT INTO public.admin_opportunity_findings (lens, "window", pattern_value_id, title, sourced_finding_md, inferences, signpost_inference_ids, claim_provenance)
        VALUES ('generic_advice', '0-6m', pv, 't', 'f', '[]'::jsonb, ARRAY[]::uuid[], '[]'::jsonb);
      RAISE EXCEPTION '0122-digest-tables: a lens outside the three was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.admin_opportunity_findings (lens, "window", pattern_value_id, title, sourced_finding_md, inferences, signpost_inference_ids, claim_provenance)
        VALUES ('capital_offtake_grant', '3-9m', pv, 't', 'f', '[]'::jsonb, ARRAY[]::uuid[], '[]'::jsonb);
      RAISE EXCEPTION '0122-digest-tables: a window outside the three was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.admin_opportunity_findings (lens, "window", pattern_value_id, title, sourced_finding_md, inferences, signpost_inference_ids, claim_provenance)
        VALUES ('capital_offtake_grant', '6-18m', gen_random_uuid(), 't', 'f', '[]'::jsonb, ARRAY[]::uuid[], '[]'::jsonb);
      RAISE EXCEPTION '0122-digest-tables: a finding about a pattern that does not exist was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.brief_reviews (kind, subject_id, batch, score, reasons, reviewed_by) VALUES ('admin-opportunity-findings', gen_random_uuid(), 'b', 1.5, 'r', 'x');
      RAISE EXCEPTION '0122-digest-tables: a score above 1 was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.brief_reviews (kind, subject_id, batch, score, reasons, reviewed_by) VALUES ('question-answers', gen_random_uuid(), 'b', 0.5, 'r', 'x');
      RAISE EXCEPTION '0122-digest-tables: a kind that authors no brief was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- INV-DIG-8, database half: a customer session (authenticated, not a platform admin) reads nothing and cannot write.
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0122@invalid.example');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.admin_opportunity_findings;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0122-digest-tables: a customer session read % finding(s)', n; END IF;
    SELECT count(*) INTO n FROM public.brief_reviews;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0122-digest-tables: a customer session read % review(s)', n; END IF;
    BEGIN
      INSERT INTO public.admin_opportunity_findings (lens, "window", pattern_value_id, title, sourced_finding_md, inferences, signpost_inference_ids, claim_provenance)
        VALUES ('capital_offtake_grant', '6-18m', pv, 'forged', 'f', '[]'::jsonb, ARRAY[]::uuid[], '[]'::jsonb);
      RAISE EXCEPTION '0122-digest-tables: a customer session wrote a finding';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    INSERT INTO public.profiles (id, email, is_platform_admin) VALUES (uid, 'selfcheck-0122@invalid.example', true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.admin_opportunity_findings;
    RESET ROLE;
    IF n <> 1 THEN RAISE EXCEPTION '0122-digest-tables: a platform admin read % finding(s), expected 1', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0122-digest-tables OK';
END $$;

COMMIT;
