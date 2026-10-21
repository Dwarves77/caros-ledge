-- down/0113.sql: reverses 0113_forward_events_target_kind.sql.

DELETE FROM public.obligations WHERE event_kind = 'target';
DELETE FROM public.item_forward_events WHERE event_kind = 'target';

ALTER TABLE public.item_forward_events
  DROP CONSTRAINT item_forward_events_event_kind_check,
  ADD CONSTRAINT item_forward_events_event_kind_check
  CHECK (event_kind = ANY (ARRAY[
    'entry_into_force'::text,
    'compliance_deadline'::text,
    'review_or_report'::text,
    'phase_step'::text,
    'consultation_close'::text,
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
    'other'::text
  ]));
