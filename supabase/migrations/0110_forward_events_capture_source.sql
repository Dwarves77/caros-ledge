-- 0110 item_forward_events may be sourced from a capture (IMPACT-1, measured on production 2026-10-20).
--
-- The extractor read an item's brief (its FACT/GAP claims and its sections) and never the item's own primary text, so an instrument whose brief did not quote a dated duty yielded no forward event: of 1,129 live items holding none, the extractor
-- found a dated duty in 9; the same extractor over the items' captures finds one in 466. A capture is the source itself, so a date located in it is verbatim in its source by construction (the extractor's assertVerbatim guard still runs).
-- A capture-backed event names its capture (source_capture_id, ON DELETE CASCADE: once the capture is gone the text the date was quoted from no longer exists to re-verify against), has source_kind 'capture', and is capped at 'medium' confidence
-- exactly as a section-backed one is (the existing high-confidence-requires-claim CHECK already says so). A claim-backed and a section-backed row are unchanged and carry no capture id.
-- Access: unchanged (the table's policies read no new column).
--
-- Reversal: down/0110.sql removes the column, the index and the constraints and restores the two-kind CHECK. It deletes the capture-backed rows first (they cannot satisfy the restored CHECK).

-- catalog: column, constraint, index

BEGIN;

ALTER TABLE public.item_forward_events ADD COLUMN source_capture_id uuid;
ALTER TABLE public.item_forward_events
  ADD CONSTRAINT item_forward_events_source_capture_id_fkey FOREIGN KEY (source_capture_id) REFERENCES public.agent_run_searches(id) ON DELETE CASCADE,
  DROP CONSTRAINT item_forward_events_source_kind_check,
  ADD CONSTRAINT item_forward_events_source_kind_check CHECK (source_kind = ANY (ARRAY['claim'::text, 'section'::text, 'capture'::text])),
  ADD CONSTRAINT item_forward_events_capture_id_matches_source_kind_check CHECK ((source_kind = 'capture'::text) = (source_capture_id IS NOT NULL));
CREATE INDEX item_forward_events_source_capture_id_idx ON public.item_forward_events (source_capture_id);

COMMENT ON COLUMN public.item_forward_events.source_capture_id IS 'FK to agent_run_searches(id) when source_kind = ''capture'' (the item''s own stored primary text the date was located in); NULL for a claim or section source. ON DELETE CASCADE: the quoted text is gone with its capture (IMPACT-1 migration 0110).';

-- Self-check 0110-forward-events-capture: the column and constraints exist; a capture-backed medium-confidence event inserts; a capture event with no capture id, a section event that names a capture, a high-confidence capture event and an unknown source kind are refused; deleting the capture deletes the event.
DO $$
DECLARE v_item uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'item_forward_events' AND column_name = 'source_capture_id' AND is_nullable = 'YES') <> 1 THEN
    RAISE EXCEPTION '0110-forward-events-capture: source_capture_id is missing or not nullable';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'item_forward_events_source_capture_id_fkey') <> 'c' THEN
    RAISE EXCEPTION '0110-forward-events-capture: the capture FK does not cascade';
  END IF;
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0110', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES (v_cap, v_item, 'https://selfcheck-0110.invalid/law', 'Operators shall report by 1 July 2027.', 0, '2026-01-01T00:00:00Z');
    INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
      VALUES (v_item, '2027-07-01', 'day', 'compliance_deadline', 'Operators shall report by 1 July 2027.', 'capture', v_cap, '1 July 2027', 'medium', 'selfcheck');
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_span, confidence, extractor_version)
        VALUES (v_item, '2027-07-02', 'day', 'other', 'x', 'capture', '2 July 2027', 'medium', 'selfcheck');
      RAISE EXCEPTION '0110-forward-events-capture: a capture event with no capture id was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
        VALUES (v_item, '2027-07-03', 'day', 'other', 'y', 'section', v_cap, '3 July 2027', 'medium', 'selfcheck');
      RAISE EXCEPTION '0110-forward-events-capture: a section event that names a capture was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
        VALUES (v_item, '2027-07-04', 'day', 'other', 'z', 'capture', v_cap, '4 July 2027', 'high', 'selfcheck');
      RAISE EXCEPTION '0110-forward-events-capture: a high-confidence capture event was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_span, confidence, extractor_version)
        VALUES (v_item, '2027-07-05', 'day', 'other', 'w', 'page', '5 July 2027', 'medium', 'selfcheck');
      RAISE EXCEPTION '0110-forward-events-capture: an unknown source kind was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    DELETE FROM public.agent_run_searches WHERE id = v_cap;
    SELECT count(*) INTO n FROM public.item_forward_events WHERE intelligence_item_id = v_item;
    IF n <> 0 THEN RAISE EXCEPTION '0110-forward-events-capture: deleting the capture left % event(s)', n; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0110-forward-events-capture OK';
END $$;

COMMIT;
