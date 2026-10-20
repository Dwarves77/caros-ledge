-- Down for 0106: the six inline expressions come back, then the one function goes.
DO $$
DECLARE
  s record;
  v_def text;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('public.validate_item_provenance(uuid)'::regprocedure, 'position(lower(btrim(r.source_span)) IN lower(r.result_content)) = 0', 'NOT public.is_verbatim(r.result_content, r.source_span)'),
    ('public.item_corrections_span_is_verbatim(uuid, uuid, text)'::regprocedure, 'position(lower(btrim(p_span)) IN lower(ars.result_content)) > 0', 'public.is_verbatim(ars.result_content, p_span)'),
    ('public.obligation_objects_guard()'::regprocedure, 'position(lower(btrim(NEW.verbatim_text)) IN lower(v_capture_text)) = 0', 'NOT public.is_verbatim(v_capture_text, NEW.verbatim_text)'),
    ('public.ledger_attribution(uuid, uuid, text)'::regprocedure, 'position(lower(btrim(p_span)) IN lower(cap.result_content)) = 0', 'NOT public.is_verbatim(cap.result_content, p_span)'),
    ('public.apply_staged_item_patch(uuid, text, jsonb, jsonb)'::regprocedure, 'position(lower(btrim(v_span)) IN lower(a.result_content)) > 0', 'public.is_verbatim(a.result_content, v_span)'),
    ('public.capture_holding_quote(text, text)'::regprocedure, 'position(lower(btrim(p_quote)) IN lower(a.result_content)) > 0', 'public.is_verbatim(a.result_content, p_quote)')
  ) AS t(fn, old_text, new_text) LOOP
    v_def := pg_get_functiondef(s.fn);
    EXECUTE replace(v_def, s.new_text, s.old_text);
  END LOOP;
END $$;
DROP FUNCTION public.is_verbatim(text, text);
