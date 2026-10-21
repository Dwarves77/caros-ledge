-- 0113 item_forward_events and obligations admit 'target' in event_kind (TURN-2, measured on production 2026-10-20).
--
-- Aspirational target sentences ("Net Zero by 2050", "targets by 2030") are forward events of kind 'target', never 'compliance_deadline', so research, analysis, market-signal and initiative items never receive a bogus compliance_deadline.
-- Access: unchanged.
--
-- Reversal: down/0113.sql deletes target-kind rows from obligations and item_forward_events and restores the six-kind CHECK constraints.

-- catalog: constraint

BEGIN;

ALTER TABLE public.item_forward_events
  DROP CONSTRAINT item_forward_events_event_kind_check,
  ADD CONSTRAINT item_forward_events_event_kind_check
  CHECK (event_kind = ANY (ARRAY[
    'entry_into_force'::text,
    'compliance_deadline'::text,
    'review_or_report'::text,
    'phase_step'::text,
    'consultation_close'::text,
    'target'::text,
    'other'::text
  ]));

ALTER TABLE public.obligations
  DROP CONSTRAINT obligations_event_kind_check,
  ADD CONSTRAINT obligations_event_kind_check
  CHECK (event_kind = ANY (ARRAY[
    'entry_into_force'::text,
    'compliance_deadline'::text,
    'review_or_report'::text,
    'phase_step'::text,
    'consultation_close'::text,
    'target'::text,
    'other'::text
  ]));

-- Self-check 0113-forward-events-target: 'target' is accepted on item_forward_events and obligations, and an unknown event_kind is refused.
DO $$
DECLARE v_item uuid := gen_random_uuid(); v_sec uuid := gen_random_uuid(); v_ev uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0113', 1);
    INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md, is_conditional) VALUES (v_sec, v_item, 'overview', 1, 'Net zero by 2050.', false);
    INSERT INTO public.item_forward_events (id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_section_id, source_span, confidence, extractor_version)
      VALUES (v_ev, v_item, '2050-01-01', 'year', 'target', 'Net zero by 2050.', 'section', v_sec, '2050', 'medium', 'selfcheck');
    INSERT INTO public.obligations (intelligence_item_id, forward_event_id, jurisdiction, modes, due_date, date_precision, event_kind, status, derivation_version)
      VALUES (v_item, v_ev, ARRAY['EU'], ARRAY['ocean'], '2050-01-01', 'year', 'target', 'active', 'selfcheck');
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_section_id, source_span, confidence, extractor_version)
        VALUES (v_item, '2050-01-02', 'year', 'bogus_kind', 'x', 'section', v_sec, '2050', 'medium', 'selfcheck');
      RAISE EXCEPTION '0113-forward-events-target: bogus event_kind was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0113-forward-events-target OK';
END $$;

COMMIT;
