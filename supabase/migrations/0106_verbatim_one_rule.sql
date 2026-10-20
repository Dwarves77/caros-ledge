-- 0106 verbatim_one_rule (R2f F2; register C:110, D:143 class). The ONE verbatim rule in the database, generated from the JavaScript rule.
--
-- criterion 3 of validate_item_provenance said "the span is, after trimming spaces, a case-insensitive substring of the capture" in its own body, and five more functions said it again in theirs
-- (item_corrections_span_is_verbatim, obligation_objects_guard, ledger_attribution, apply_staged_item_patch, capture_holding_quote). The rule now has one SQL home, public.is_verbatim(capture, span), rendered by
-- renderVerbatimSql() in src/core/contracts/verbatim.ts from the same constants as isVerbatim (a test regenerates the function and diffs it against the block below; schema:local runs both on 40 spans and they agree).
-- Each of the six functions keeps every other line of its body: only the inline position(lower(btrim(...))) expression is replaced by a call, so the verdict they give is unchanged.
-- Access: is_verbatim reads no table; it is executable by every role, as lower() is.
--
-- Reversal: down/0106.sql puts the six inline expressions back and drops is_verbatim.

-- catalog: function

BEGIN;

-- BEGIN generated: src/core/contracts/verbatim.ts renderVerbatimSql(); do not edit by hand
CREATE OR REPLACE FUNCTION public.is_verbatim(p_capture text, p_span text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p_capture IS NOT NULL AND p_span IS NOT NULL AND btrim(p_span, ' ') <> ''
     AND position(lower(btrim(p_span, ' ')) IN lower(p_capture)) > 0
$$;
-- END generated

COMMENT ON FUNCTION public.is_verbatim(text, text) IS 'The one verbatim rule (ADR-016, criterion 3): the span, trimmed of spaces, is a case-insensitive substring of the capture. Generated from src/core/contracts/verbatim.ts (migration 0106).';

DO $$
DECLARE
  s record;
  v_def text;
  v_new text;
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
    IF (length(v_def) - length(replace(v_def, s.old_text, ''))) <> length(s.old_text) THEN
      RAISE EXCEPTION '0106-verbatim-one-rule: % does not hold the inline rule exactly once', s.fn;
    END IF;
    v_new := replace(v_def, s.old_text, s.new_text);
    EXECUTE v_new;
  END LOOP;
END $$;

-- Self-check 0106-verbatim-one-rule: the function answers the rule on its edges (case, space trim, tab and newline not trimmed, null, empty); no function in public still carries an inline copy of the rule; the six
-- callers now call it; and two of them are exercised on rows: a quote the capture holds (any case) finds its capture, a quote it does not hold finds none, and the corrections check agrees.
DO $$
DECLARE
  v_item uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid(); v_msg text; v_left text; v_missing text;
BEGIN
  IF NOT public.is_verbatim('Article 4 states a limit.', '  ARTICLE 4 STATES  ') OR public.is_verbatim('Article 4 states a limit.', 'article 5') THEN RAISE EXCEPTION '0106-verbatim-one-rule: case or substring rule wrong'; END IF;
  IF public.is_verbatim('a b', E'\ta\t') OR NOT public.is_verbatim(E'x\ta\ty', E'\ta\t') THEN RAISE EXCEPTION '0106-verbatim-one-rule: tabs must not be trimmed'; END IF;
  IF public.is_verbatim(NULL, 'a') OR public.is_verbatim('a', NULL) OR public.is_verbatim('a', '   ') OR public.is_verbatim('', 'a') THEN RAISE EXCEPTION '0106-verbatim-one-rule: null or empty matched'; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'is_verbatim' AND p.prosrc LIKE '%position(lower(btrim(%';
  IF v_left IS NOT NULL THEN RAISE EXCEPTION '0106-verbatim-one-rule: an inline copy of the rule remains in %', v_left; END IF;
  SELECT string_agg(f, ', ') INTO v_missing FROM unnest(ARRAY['validate_item_provenance', 'item_corrections_span_is_verbatim', 'obligation_objects_guard', 'ledger_attribution', 'apply_staged_item_patch', 'capture_holding_quote']) f
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f AND p.prosrc LIKE '%public.is_verbatim(%');
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION '0106-verbatim-one-rule: % do not call is_verbatim', v_missing; END IF;
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0106', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES (v_cap, v_item, 'https://regulator-0106.invalid/law', 'Article 4 states a limit of 91,16 grams per MJ.', 0, '2026-01-01T00:00:00Z');
    IF public.capture_holding_quote('https://regulator-0106.invalid/law', 'ARTICLE 4 STATES A LIMIT') IS DISTINCT FROM v_cap THEN RAISE EXCEPTION '0106-verbatim-one-rule: a held quote found no capture'; END IF;
    IF public.capture_holding_quote('https://regulator-0106.invalid/law', 'a limit of 99 grams') IS NOT NULL THEN RAISE EXCEPTION '0106-verbatim-one-rule: a quote the capture does not hold found a capture'; END IF;
    IF NOT public.item_corrections_span_is_verbatim(v_item, v_cap, 'a limit of 91,16 grams') OR public.item_corrections_span_is_verbatim(v_item, v_cap, 'a limit of 99 grams') THEN RAISE EXCEPTION '0106-verbatim-one-rule: the corrections check disagrees with the rule'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0106-verbatim-one-rule: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0106-verbatim-one-rule: rollback sentinel' THEN RAISE; END IF;
  END;
  RAISE NOTICE '0106-verbatim-one-rule OK';
END $$;

COMMIT;
