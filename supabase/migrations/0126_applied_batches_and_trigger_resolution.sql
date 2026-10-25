-- 0126 applied_batches and pending-trigger resolution (FLY-1 wiring, ADR-050).
--
-- applied_batches is the ledger of committed session batches the turn's briefs stage has read: one row per batch file, keyed by its batch id (the file name without .json), carrying the kind, the status (applied: every
-- entry written or already written; held: at least one entry refused or the file refused whole, the reasons kept), the content hash of the file as read (a held batch is read again only when its file changed), the harness
-- run that recorded it and the counts of that apply. service_role only.
--
-- item_forward_events gains the resolution of a pending regulatory trigger (implementing_act_due, delegated_act_due, guidance_expected): resolved_at, the capture that states the act or the guidance
-- (resolved_capture_id; SET NULL if the capture is ever removed, the verbatim span stays) and resolved_span, the verbatim text of that statement. Time and span are set together or not at all; only the three pending kinds can be resolved.
-- Access: item_forward_events unchanged (its policies read no new column); applied_batches RLS on, no policy.
--
-- Reversal: down/0126.sql drops the table and the three columns with their constraints and index.

-- catalog: relation, column, constraint, index, acl

BEGIN;

CREATE TABLE public.applied_batches (
  batch_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  file_hash text NOT NULL,
  run_id uuid,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applied_batches_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.harness_runs(id) ON DELETE SET NULL,
  CONSTRAINT applied_batches_batch_id_check CHECK (length(btrim(batch_id)) > 0),
  CONSTRAINT applied_batches_kind_check CHECK (length(btrim(kind)) > 0),
  CONSTRAINT applied_batches_status_check CHECK (status = ANY (ARRAY['applied'::text, 'held'::text])),
  CONSTRAINT applied_batches_file_hash_check CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT applied_batches_counts_object CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT applied_batches_reasons_array CHECK (jsonb_typeof(reasons) = 'array')
);
ALTER TABLE public.applied_batches ADD CONSTRAINT applied_batches_pkey PRIMARY KEY (batch_id);
CREATE INDEX applied_batches_run_id_idx ON public.applied_batches (run_id);

COMMENT ON TABLE public.applied_batches IS 'The committed session batches the turn briefs stage has read (FLY-1 migration 0126): batch id, kind, status applied or held, the file content hash, the run, the counts and the held reasons. service_role only.';

ALTER TABLE public.applied_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.applied_batches FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.applied_batches TO service_role;

ALTER TABLE public.item_forward_events
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_capture_id uuid,
  ADD COLUMN resolved_span text,
  ADD CONSTRAINT item_forward_events_resolved_capture_id_fkey FOREIGN KEY (resolved_capture_id) REFERENCES public.agent_run_searches(id) ON DELETE SET NULL,
  ADD CONSTRAINT item_forward_events_resolution_pair_check CHECK ((resolved_at IS NULL) = (resolved_span IS NULL)),
  ADD CONSTRAINT item_forward_events_resolved_capture_needs_resolution_check CHECK (resolved_capture_id IS NULL OR resolved_at IS NOT NULL),
  ADD CONSTRAINT item_forward_events_resolved_only_pending_check CHECK (resolved_at IS NULL OR event_kind = ANY (ARRAY['implementing_act_due'::text, 'delegated_act_due'::text, 'guidance_expected'::text]));
CREATE INDEX item_forward_events_resolved_capture_id_idx ON public.item_forward_events (resolved_capture_id);

COMMENT ON COLUMN public.item_forward_events.resolved_at IS 'When the turn resolved this pending regulatory trigger (implementing_act_due, delegated_act_due, guidance_expected) from a later capture that states the act or the guidance; NULL while it is pending (FLY-1 migration 0126).';
COMMENT ON COLUMN public.item_forward_events.resolved_capture_id IS 'The capture whose text states the act or the guidance; SET NULL if the capture is removed, resolved_span stays (FLY-1 migration 0126).';
COMMENT ON COLUMN public.item_forward_events.resolved_span IS 'The verbatim text, in the resolving capture, that states the act or the guidance (FLY-1 migration 0126).';

-- Self-check 0126-applied-batches: shape and access; in a fixture that rolls back a batch row stores and reads back as written, an unknown status, a malformed hash and a non-object counts value are refused, and deleting the run clears run_id
-- without deleting the row; as `authenticated` the table cannot be read or written; a pending trigger resolves with its span and capture, a resolution with no span, a capture with no resolution and the resolution of a dated duty are refused, and removing the capture keeps the span.
DO $$
DECLARE rid uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid(); v_res uuid := gen_random_uuid(); v_ev uuid := gen_random_uuid(); v_duty uuid := gen_random_uuid();
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.applied_batches'::regclass) THEN RAISE EXCEPTION '0126-applied-batches: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.applied_batches', 'SELECT') OR has_table_privilege('authenticated', 'public.applied_batches', 'SELECT') OR has_table_privilege('authenticated', 'public.applied_batches', 'INSERT') THEN
    RAISE EXCEPTION '0126-applied-batches: a client role holds a privilege';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.applied_batches', 'INSERT') THEN RAISE EXCEPTION '0126-applied-batches: service_role cannot write'; END IF;
  BEGIN
    INSERT INTO public.harness_runs (id, family, root_run_id, outcome, started_at, finished_at) VALUES (rid, 'selfcheck', rid, 'noop', now(), now());
    INSERT INTO public.applied_batches (batch_id, kind, status, file_hash, run_id, counts) VALUES ('record-briefs-selfcheck', 'record-briefs', 'applied', repeat('a', 64), rid, '{"applied":2}');
    IF (SELECT counts ->> 'applied' FROM public.applied_batches WHERE batch_id = 'record-briefs-selfcheck') <> '2' THEN RAISE EXCEPTION '0126-applied-batches: the row did not read back as written'; END IF;
    BEGIN INSERT INTO public.applied_batches (batch_id, kind, status, file_hash) VALUES ('record-briefs-selfcheck-2', 'record-briefs', 'pending', repeat('a', 64)); RAISE EXCEPTION '0126-applied-batches: an unknown status was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.applied_batches (batch_id, kind, status, file_hash) VALUES ('record-briefs-selfcheck-3', 'record-briefs', 'held', 'xyz'); RAISE EXCEPTION '0126-applied-batches: a malformed hash was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.applied_batches (batch_id, kind, status, file_hash, counts) VALUES ('record-briefs-selfcheck-4', 'record-briefs', 'held', repeat('b', 64), '[]'); RAISE EXCEPTION '0126-applied-batches: a non-object counts value was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    DELETE FROM public.harness_runs WHERE id = rid;
    IF (SELECT run_id FROM public.applied_batches WHERE batch_id = 'record-briefs-selfcheck') IS NOT NULL THEN RAISE EXCEPTION '0126-applied-batches: deleting the run left run_id set'; END IF;
    SET LOCAL ROLE authenticated;
    BEGIN PERFORM 1 FROM public.applied_batches; RAISE EXCEPTION '0126-applied-batches: authenticated read the ledger';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;

    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0126', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES (v_cap, v_item, 'https://selfcheck-0126.invalid/law', 'The Commission shall adopt implementing acts by 2027.', 0, '2026-01-01T00:00:00Z');
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES (v_res, v_item, 'https://selfcheck-0126.invalid/law', 'Commission Implementing Regulation (EU) 2027/1 was adopted.', 1, '2027-01-01T00:00:00Z');
    INSERT INTO public.item_forward_events (id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
      VALUES (v_ev, v_item, '2027-01-01', 'year', 'implementing_act_due', 'The Commission shall adopt implementing acts by 2027.', 'capture', v_cap, '2027', 'medium', 'selfcheck');
    INSERT INTO public.item_forward_events (id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
      VALUES (v_duty, v_item, '2027-02-01', 'day', 'compliance_deadline', 'Operators shall report by 1 February 2027.', 'capture', v_cap, '1 February 2027', 'medium', 'selfcheck');
    BEGIN UPDATE public.item_forward_events SET resolved_at = now() WHERE id = v_ev; RAISE EXCEPTION '0126-applied-batches: a resolution with no span was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.item_forward_events SET resolved_capture_id = v_res WHERE id = v_ev; RAISE EXCEPTION '0126-applied-batches: a resolving capture with no resolution was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.item_forward_events SET resolved_at = now(), resolved_capture_id = v_res, resolved_span = 'Commission Implementing Regulation (EU) 2027/1' WHERE id = v_duty; RAISE EXCEPTION '0126-applied-batches: a dated duty was resolved as a pending trigger';
    EXCEPTION WHEN check_violation THEN NULL; END;
    UPDATE public.item_forward_events SET resolved_at = now(), resolved_capture_id = v_res, resolved_span = 'Commission Implementing Regulation (EU) 2027/1' WHERE id = v_ev;
    DELETE FROM public.agent_run_searches WHERE id = v_res;
    IF (SELECT resolved_capture_id FROM public.item_forward_events WHERE id = v_ev) IS NOT NULL THEN RAISE EXCEPTION '0126-applied-batches: removing the resolving capture left resolved_capture_id set'; END IF;
    IF (SELECT resolved_span FROM public.item_forward_events WHERE id = v_ev) IS DISTINCT FROM 'Commission Implementing Regulation (EU) 2027/1' THEN RAISE EXCEPTION '0126-applied-batches: removing the capture lost the resolved span'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0126-applied-batches OK';
END $$;

COMMIT;
