-- 0077 capture_holding_quote (R2b, MASTER I5; register D:10, 69, 114). The stored capture id a quote stands on.
--
-- A statutory input's quote and a producer row's citation quote were required to be non-empty strings and nothing more; no capture of the cited page was ever asked whether it holds the words. This function is the
-- database half of that question, in criterion 3's own terms (position of the lower-cased, space-trimmed quote in the lower-cased capture), run where the capture text lives so the page never travels:
--   capture_holding_quote(url, quote) -> uuid: the id of the newest stored capture (agent_run_searches row) of that URL (the citation canonicalisation of criterion 2) whose text holds the quote, or NULL.
-- The caller stores the id beside the quote (a quote with no capture id is not accepted); the application's offline check (filing grade, derived in CI) runs the same test over exported capture text.
-- Executable by service_role only. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.capture_holding_quote(text, text).

-- catalog: function

BEGIN;

CREATE FUNCTION public.capture_holding_quote(p_url text, p_quote text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT a.id
    FROM public.agent_run_searches a
   WHERE coalesce(btrim(p_quote), '') <> '' AND coalesce(p_url, '') <> ''
     AND a.result_url ILIKE '%' || public.ledger_host_of(p_url) || '%'
     AND public.canonicalize_citation_url(a.result_url) = public.canonicalize_citation_url(p_url)
     AND a.result_content IS NOT NULL AND position(lower(btrim(p_quote)) IN lower(a.result_content)) > 0
   ORDER BY a.searched_at DESC NULLS LAST, a.id
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.capture_holding_quote(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_holding_quote(text, text) TO service_role;
COMMENT ON FUNCTION public.capture_holding_quote(text, text) IS 'The newest stored capture of a URL that holds a quote verbatim (criterion 3 test), or NULL (R2b 0077, D:10): a quote is accepted only with this id.';

-- Self-check 0077-capture-quote: a quote the capture holds (any case) returns that capture, the newest of two; a quote no capture of the URL holds, a quote held only by a capture of another URL, a blank quote and a
-- blank URL return NULL; a client role cannot execute the function.
DO $$
DECLARE
  v_item uuid := gen_random_uuid(); v_old uuid := gen_random_uuid(); v_new uuid := gen_random_uuid(); v_elsewhere uuid := gen_random_uuid(); v_msg text;
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0077', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES
      (v_old, v_item, 'https://www.regulator-0077.invalid/law/', 'Article 4 states a limit of 91,16 grams per MJ.', 0, '2026-01-01T00:00:00Z'),
      (v_new, v_item, 'https://regulator-0077.invalid/law', 'Article 4 states a limit of 91,16 grams per MJ. Article 5 follows.', 1, '2026-02-01T00:00:00Z'),
      (v_elsewhere, v_item, 'https://other-0077.invalid/page', 'A sentence only the other page holds.', 2, '2026-03-01T00:00:00Z');
    IF public.capture_holding_quote('https://regulator-0077.invalid/law', 'ARTICLE 4 STATES A LIMIT OF 91,16 GRAMS PER MJ.') IS DISTINCT FROM v_new THEN RAISE EXCEPTION '0077-capture-quote: the newest holding capture was not returned'; END IF;
    IF public.capture_holding_quote('https://regulator-0077.invalid/law', 'A sentence only the other page holds.') IS NOT NULL THEN RAISE EXCEPTION '0077-capture-quote: another URL''s capture backed the quote'; END IF;
    IF public.capture_holding_quote('https://regulator-0077.invalid/law', 'a limit of 99 grams') IS NOT NULL THEN RAISE EXCEPTION '0077-capture-quote: a quote no capture holds was accepted'; END IF;
    IF public.capture_holding_quote('https://regulator-0077.invalid/law', '   ') IS NOT NULL OR public.capture_holding_quote('', 'x') IS NOT NULL THEN RAISE EXCEPTION '0077-capture-quote: a blank input returned a capture'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0077-capture-quote: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0077-capture-quote: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'public.capture_holding_quote(text, text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.capture_holding_quote(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0077-capture-quote: a client role can execute capture_holding_quote';
  END IF;
  RAISE NOTICE '0077-capture-quote OK';
END $$;

COMMIT;
