-- 0008 harness_runs reshaped into the one ledger (P2-S1, owed by register P1-08 harness.md section 8 "Data model (the one
-- ledger; P1-11 owns the migration)" and P1-11 schema.md section 8 "Added").
--
-- Baseline (old migration 331): run_id text primary key, harness_family, harness_version, started_at, finished_at (never
-- written), trigger, github_run_id, upstream_run_id (text), config, inputs_ref, per_item, metrics, defects_found,
-- full_trace_refs, source_branch, source_artifact_path, created_at; RLS on, no policy, anon and authenticated revoked.
-- After: id uuid primary key, family, root_run_id (the loop id; equals id for a chain head), upstream_run_id uuid referencing
-- harness_runs(id), trigger (dispatch | chained | push | schedule | manual), mode (dry | apply), forced_dry, outcome
-- (success | noop | refused | failed | unknown), reason, inputs, outputs, error, code_sha, github_run_id, started_at,
-- finished_at (not null), created_at. One table, one recorder (src/core/harness): the parallel ledgers brief_apply_runs and
-- d3_runs fold into it by their writers moving; those tables are dropped by a later migration after their rows are exported.
--
-- NO ROW IS LOST. The columns the register does not carry (harness_version, per_item, defects_found, full_trace_refs,
-- source_branch, source_artifact_path, config, inputs_ref, metrics, and the text run_id and upstream_run_id) are folded into
-- the inputs and outputs documents of the same row before they are dropped:
--   inputs  = {config, inputs_ref, legacy_run_id, legacy_upstream_run_id, legacy_trigger, harness_version, source_branch,
--              source_artifact_path}
--   outputs = {metrics, per_item, defects_found, full_trace_refs}
-- A legacy row's outcome is 'unknown' (the old ledger recorded none; inventing one would be fabrication), its root_run_id is its
-- own id, its upstream_run_id is the row whose legacy run_id the text named (NULL if no row matches), and finished_at, which
-- the old writer never set, takes started_at. The old trigger values map workflow_dispatch -> dispatch and workflow_run ->
-- chained; any other legacy value becomes NULL (it stays in inputs.legacy_trigger).
--
-- Access: RLS on. service_role writes (it bypasses RLS and holds its grants). authenticated reads through one policy limited to
-- platform admins (the ledger holds run inputs and error text, not customer data a member should see). anon: nothing.
-- Not applied to production before the cutover window; the harness code that writes the old shape is replaced by P2-08.
--
-- Reversal: not reversible without the legacy documents; re-create the old columns from inputs and outputs if ever needed.

-- catalog: column, constraint, index, policy, acl

BEGIN;

ALTER TABLE public.harness_runs
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN family text,
  ADD COLUMN root_run_id uuid,
  ADD COLUMN upstream_id uuid,
  ADD COLUMN mode text,
  ADD COLUMN forced_dry boolean NOT NULL DEFAULT false,
  ADD COLUMN outcome text,
  ADD COLUMN reason text,
  ADD COLUMN inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN error text,
  ADD COLUMN code_sha text;

UPDATE public.harness_runs h SET
  family = h.harness_family,
  root_run_id = h.id,
  upstream_id = (SELECT u.id FROM public.harness_runs u WHERE u.run_id = h.upstream_run_id),
  outcome = 'unknown',
  finished_at = coalesce(h.finished_at, h.started_at),
  inputs = jsonb_build_object('config', h.config, 'inputs_ref', h.inputs_ref, 'legacy_run_id', h.run_id,
                              'legacy_upstream_run_id', h.upstream_run_id, 'legacy_trigger', h.trigger,
                              'harness_version', h.harness_version, 'source_branch', h.source_branch,
                              'source_artifact_path', h.source_artifact_path),
  outputs = jsonb_build_object('metrics', h.metrics, 'per_item', h.per_item, 'defects_found', h.defects_found,
                               'full_trace_refs', h.full_trace_refs),
  trigger = CASE h.trigger WHEN 'workflow_dispatch' THEN 'dispatch' WHEN 'workflow_run' THEN 'chained'
                           WHEN 'push' THEN 'push' WHEN 'manual' THEN 'manual' WHEN 'schedule' THEN 'schedule'
                           WHEN 'dispatch' THEN 'dispatch' WHEN 'chained' THEN 'chained' ELSE NULL END;

ALTER TABLE public.harness_runs
  DROP CONSTRAINT harness_runs_pkey,
  DROP COLUMN run_id, DROP COLUMN harness_family, DROP COLUMN harness_version, DROP COLUMN upstream_run_id,
  DROP COLUMN config, DROP COLUMN inputs_ref, DROP COLUMN per_item, DROP COLUMN metrics,
  DROP COLUMN defects_found, DROP COLUMN full_trace_refs, DROP COLUMN source_branch, DROP COLUMN source_artifact_path;

ALTER TABLE public.harness_runs RENAME COLUMN upstream_id TO upstream_run_id;

ALTER TABLE public.harness_runs
  ALTER COLUMN family SET NOT NULL,
  ALTER COLUMN root_run_id SET NOT NULL,
  ALTER COLUMN outcome SET NOT NULL,
  ALTER COLUMN finished_at SET NOT NULL,
  ADD CONSTRAINT harness_runs_pkey PRIMARY KEY (id),
  ADD CONSTRAINT harness_runs_upstream_run_id_fkey FOREIGN KEY (upstream_run_id) REFERENCES public.harness_runs(id),
  ADD CONSTRAINT harness_runs_outcome_check CHECK (outcome IN ('success', 'noop', 'refused', 'failed', 'unknown')),
  ADD CONSTRAINT harness_runs_mode_check CHECK (mode IS NULL OR mode IN ('dry', 'apply')),
  ADD CONSTRAINT harness_runs_trigger_check CHECK (trigger IS NULL OR trigger IN ('dispatch', 'chained', 'push', 'schedule', 'manual')),
  ADD CONSTRAINT harness_runs_finished_after_started_check CHECK (finished_at >= started_at);

CREATE INDEX harness_runs_family_started_at_idx ON public.harness_runs (family, started_at DESC);
CREATE INDEX harness_runs_root_run_id_idx ON public.harness_runs (root_run_id);
CREATE INDEX harness_runs_upstream_run_id_idx ON public.harness_runs (upstream_run_id);

COMMENT ON TABLE public.harness_runs IS
  'The one run ledger (P2-S1 migration 0008). One row per harness run, written by the single recorder in src/core/harness through the service role; read by platform admins. root_run_id is the loop id (equal to id for a chain head); upstream_run_id is the run that triggered this one. Legacy rows keep their old documents under inputs and outputs and carry outcome unknown.';

ALTER TABLE public.harness_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.harness_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.harness_runs TO authenticated;
GRANT ALL ON TABLE public.harness_runs TO service_role;
CREATE POLICY harness_runs_read_platform_admin ON public.harness_runs FOR SELECT TO authenticated
  USING ((SELECT public.is_platform_admin()));

-- Self-check 0008-harness-runs: the shape, the key, the access, and an attack: a non-admin reads nothing even when a row exists.
DO $$
DECLARE cols text; n int;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'harness_runs';
  IF cols <> 'code_sha,created_at,error,family,finished_at,forced_dry,github_run_id,id,inputs,mode,outcome,outputs,reason,root_run_id,started_at,trigger,upstream_run_id' THEN
    RAISE EXCEPTION '0008-harness-runs: unexpected columns %', cols;
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'harness_runs_pkey') <> 'PRIMARY KEY (id)' THEN
    RAISE EXCEPTION '0008-harness-runs: primary key is not (id)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.harness_runs'::regclass) THEN
    RAISE EXCEPTION '0008-harness-runs: RLS is off';
  END IF;
  IF has_table_privilege('anon', 'public.harness_runs', 'SELECT') OR has_table_privilege('authenticated', 'public.harness_runs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.harness_runs', 'UPDATE') OR has_table_privilege('authenticated', 'public.harness_runs', 'DELETE') THEN
    RAISE EXCEPTION '0008-harness-runs: anon reads or authenticated writes';
  END IF;
  INSERT INTO public.harness_runs (family, root_run_id, outcome, started_at, finished_at)
    VALUES ('selfcheck', gen_random_uuid(), 'noop', now(), now());
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.harness_runs;
  RESET ROLE;
  IF n <> 0 THEN RAISE EXCEPTION '0008-harness-runs: a non-admin read % rows', n; END IF;
  DELETE FROM public.harness_runs WHERE family = 'selfcheck';
  RAISE NOTICE '0008-harness-runs OK';
END $$;

COMMIT;
