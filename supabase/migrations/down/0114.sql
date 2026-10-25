-- down/0114.sql: reverses 0114_forward_events_pending_triggers.sql.
DELETE FROM public.obligations WHERE event_kind IN ('implementing_act_due', 'delegated_act_due', 'guidance_expected');
DELETE FROM public.item_forward_events WHERE event_kind IN ('implementing_act_due', 'delegated_act_due', 'guidance_expected');

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
