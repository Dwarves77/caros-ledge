-- 0027 edge_snapshots (P2-S3, owed by IMPROVEMENTS IMP-047).
--
-- The corpus pass refreshes machine-written item_cross_references rows and snapshots each row it is about to overwrite (rule 15: prior-state
-- evidence) through an injected SnapshotSink that, until now, had no default and so wrote nowhere. This table is the default sink's
-- destination: one row per chunk of prior rows, tied to the harness run that took it, so the evidence outlives the run and the harness
-- can read it.
--   run_id        uuid, references harness_runs(id) (0008 made id the key); ON DELETE CASCADE: a pruned run takes its evidence with it.
--   table_name    the table whose rows were snapshotted (item_cross_references today).
--   rows          the prior rows, a jsonb array.
--   taken_at      when the snapshot was taken.
-- RLS on, no policy: service_role only (INV-139). Not applied to production before the cutover window.
--
-- Reversal: DROP TABLE public.edge_snapshots.

-- catalog: relation, column, constraint, index, acl

BEGIN;

CREATE TABLE public.edge_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  table_name text NOT NULL,
  rows jsonb NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edge_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.harness_runs(id) ON DELETE CASCADE,
  CONSTRAINT edge_snapshots_table_name_check CHECK (length(btrim(table_name)) > 0),
  CONSTRAINT edge_snapshots_rows_array CHECK (jsonb_typeof(rows) = 'array')
);
ALTER TABLE public.edge_snapshots ADD CONSTRAINT edge_snapshots_pkey PRIMARY KEY (id);
CREATE INDEX edge_snapshots_run_id_idx ON public.edge_snapshots (run_id, taken_at);

COMMENT ON TABLE public.edge_snapshots IS 'Prior-state snapshots the corpus pass takes before it overwrites machine-written edges (P2-S3 migration 0027). One row per chunk, tied to the harness run; service_role only.';

ALTER TABLE public.edge_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.edge_snapshots FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.edge_snapshots TO service_role;

-- Self-check 0027-edge-snapshots: shape and access; in a fixture that rolls back a snapshot of a real run is stored and read back as written; a
-- snapshot of an unknown run, a non-array rows value and a blank table name are each refused; deleting the run deletes its snapshots; as
-- `authenticated` the table cannot be read or written.
DO $$
DECLARE rid uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'edge_snapshots')
     <> 'id,rows,run_id,table_name,taken_at' THEN
    RAISE EXCEPTION '0027-edge-snapshots: unexpected columns';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.edge_snapshots'::regclass) THEN RAISE EXCEPTION '0027-edge-snapshots: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.edge_snapshots', 'SELECT') OR has_table_privilege('authenticated', 'public.edge_snapshots', 'SELECT')
     OR has_table_privilege('authenticated', 'public.edge_snapshots', 'INSERT') THEN
    RAISE EXCEPTION '0027-edge-snapshots: a client role holds a privilege';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.edge_snapshots', 'INSERT') THEN RAISE EXCEPTION '0027-edge-snapshots: service_role cannot write'; END IF;
  BEGIN
    INSERT INTO public.harness_runs (id, family, root_run_id, outcome, started_at, finished_at) VALUES (rid, 'selfcheck', rid, 'noop', now(), now());
    INSERT INTO public.edge_snapshots (run_id, table_name, rows) VALUES (rid, 'item_cross_references', '[{"source_item_id":"a","target_item_id":"b"}]');
    IF (SELECT rows -> 0 ->> 'target_item_id' FROM public.edge_snapshots WHERE run_id = rid) <> 'b' THEN RAISE EXCEPTION '0027-edge-snapshots: the snapshot did not read back as written'; END IF;
    BEGIN INSERT INTO public.edge_snapshots (run_id, table_name, rows) VALUES (gen_random_uuid(), 'item_cross_references', '[]'); RAISE EXCEPTION '0027-edge-snapshots: a snapshot of an unknown run was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN INSERT INTO public.edge_snapshots (run_id, table_name, rows) VALUES (rid, 'item_cross_references', '{}'); RAISE EXCEPTION '0027-edge-snapshots: a non-array rows value was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.edge_snapshots (run_id, table_name, rows) VALUES (rid, ' ', '[]'); RAISE EXCEPTION '0027-edge-snapshots: a blank table name was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    SET LOCAL ROLE authenticated;
    BEGIN PERFORM 1 FROM public.edge_snapshots; RAISE EXCEPTION '0027-edge-snapshots: authenticated read the snapshots';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN INSERT INTO public.edge_snapshots (run_id, table_name, rows) VALUES (rid, 'x', '[]'); RAISE EXCEPTION '0027-edge-snapshots: authenticated wrote a snapshot';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    DELETE FROM public.harness_runs WHERE id = rid;
    SELECT count(*) INTO n FROM public.edge_snapshots WHERE run_id = rid;
    IF n <> 0 THEN RAISE EXCEPTION '0027-edge-snapshots: % snapshot(s) outlived their run', n; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0027-edge-snapshots OK';
END $$;

COMMIT;
