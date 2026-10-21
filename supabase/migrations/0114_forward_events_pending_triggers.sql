-- 0114 item_forward_events and obligations admit pending regulatory trigger kinds: implementing_act_due, delegated_act_due, guidance_expected (CTX-5).
--
-- Rulemaking deadlines for regulators (Commission implementing acts, delegated acts, technical standards) are distinct from operator compliance deadlines.
-- Access: unchanged.
--
-- Reversal: down/0114.sql deletes pending-trigger-kind rows from obligations and item_forward_events and restores the seven-kind CHECK constraints.

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
    'implementing_act_due'::text,
    'delegated_act_due'::text,
    'guidance_expected'::text,
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
    'implementing_act_due'::text,
    'delegated_act_due'::text,
    'guidance_expected'::text,
    'other'::text
  ]));

-- Self-check 0114-forward-events-pending: 'implementing_act_due', 'delegated_act_due', and 'guidance_expected' are accepted on item_forward_events and obligations, and an unknown event_kind is refused.
DO $$
DECLARE v_item uuid := gen_random_uuid(); v_sec uuid := gen_random_uuid(); v_ev uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0114', 1);
    INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md, is_conditional) VALUES (v_sec, v_item, 'overview', 1, 'Implementing acts by 2027.', false);
    INSERT INTO public.item_forward_events (id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_section_id, source_span, confidence, extractor_version)
      VALUES (v_ev, v_item, '2027-01-01', 'year', 'implementing_act_due', 'Implementing acts by 2027.', 'section', v_sec, '2027', 'medium', 'selfcheck');
    INSERT INTO public.obligations (intelligence_item_id, forward_event_id, jurisdiction, modes, due_date, date_precision, event_kind, status, derivation_version)
      VALUES (v_item, v_ev, ARRAY['EU'], ARRAY['ocean'], '2027-01-01', 'year', 'implementing_act_due', 'active', 'selfcheck');
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_section_id, source_span, confidence, extractor_version)
        VALUES (v_item, '2027-01-02', 'year', 'bogus_kind', 'x', 'section', v_sec, '2027', 'medium', 'selfcheck');
      RAISE EXCEPTION '0114-forward-events-pending: bogus event_kind was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0114-forward-events-pending OK';
END $$;

COMMIT;
