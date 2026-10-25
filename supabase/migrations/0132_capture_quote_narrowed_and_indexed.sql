-- 0132 capture_holding_quote narrowed to the cited URL and indexed (FIX-QUOTE-1).
--
-- Why: the ruled runs 40208274761 and 40209206950 died on the first rows-file apply step with "canceling statement due to statement timeout". capture_holding_quote(url, quote) tested the quote with is_verbatim()
-- (lower() of the whole capture text) BEFORE it tested the URL: inside the function the URL is a parameter, so the planner could not fold the host and canonical-URL tests, ranked the cheap-looking is_verbatim first
-- and ran it over EVERY capture with text (6,390 rows, 620 MB of TOAST text on production), whatever URL was cited. Measured on production, read-only: 10.5 s per call for any URL (service_role runs under the
-- authenticator's statement_timeout of 8 s); the seq scan had no index to use on result_url (agent_run_searches_url_hash_idx is partial, first-fetch rows only).
--
-- What: the function now finds the captures of the cited URL first (a MATERIALIZED step the planner cannot reorder past) and runs the verbatim test on those rows only, newest first as before. A new expression index on
-- canonicalize_citation_url(result_url) lets that first step read the cited URL's captures without scanning the table. The verdict is unchanged: same URL canonicalisation (criterion 2), same is_verbatim (criterion 3),
-- the newest holding capture or NULL, the same blank guards, the same grants.
--
-- Access: unchanged (service_role only).
--
-- Reversal: down/0132.sql restores the 0106 body and drops the index.

-- catalog: function, index

BEGIN;

CREATE INDEX agent_run_searches_canonical_url_idx ON public.agent_run_searches (public.canonicalize_citation_url(result_url));

CREATE OR REPLACE FUNCTION public.capture_holding_quote(p_url text, p_quote text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH cited AS MATERIALIZED (
    SELECT a.id, a.searched_at, a.result_content
      FROM public.agent_run_searches a
     WHERE coalesce(btrim(p_quote), '') <> '' AND coalesce(p_url, '') <> ''
       AND a.result_url ILIKE '%' || public.ledger_host_of(p_url) || '%'
       AND public.canonicalize_citation_url(a.result_url) = public.canonicalize_citation_url(p_url)
       AND a.result_content IS NOT NULL
  )
  SELECT c.id
    FROM cited c
   WHERE public.is_verbatim(c.result_content, p_quote)
   ORDER BY c.searched_at DESC NULLS LAST, c.id
   LIMIT 1
$$;

-- Self-check 0132-capture-quote-narrowed: the index exists on the canonical-URL expression; the verdict is unchanged (the newest of two holding captures, case-insensitive; another URL's capture never backs the quote; a quote no
-- capture holds, a blank quote and a blank URL return NULL); the grants are unchanged (service_role only); and the verbatim test runs on the cited URL's captures ONLY: with 50 captures of other URLs that all hold the
-- quote and 2 of the cited URL, is_verbatim (replaced for the fixture by a counting twin, rolled back with it) is called for no more than the 2 rows of the cited URL, with the index switched off so the function's own shape is what is proved.
DO $$
DECLARE
  v_item uuid := gen_random_uuid(); v_old uuid := gen_random_uuid(); v_new uuid := gen_random_uuid(); v_msg text; v_calls int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'agent_run_searches' AND i.indexname = 'agent_run_searches_canonical_url_idx' AND i.indexdef LIKE '%canonicalize_citation_url(result_url)%') THEN
    RAISE EXCEPTION '0132-capture-quote-narrowed: the canonical-URL index is missing';
  END IF;
  IF has_function_privilege('anon', 'public.capture_holding_quote(text, text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.capture_holding_quote(text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.capture_holding_quote(text, text)', 'EXECUTE') OR NOT has_function_privilege('service_role', 'public.canonicalize_citation_url(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0132-capture-quote-narrowed: the grants changed (service_role only must execute capture_holding_quote, and must execute the index expression)';
  END IF;
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0132', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES
      (v_old, v_item, 'https://www.regulator-0132.invalid/law/', 'Article 4 states a limit of 91,16 grams per MJ.', 0, '2026-01-01T00:00:00Z'),
      (v_new, v_item, 'https://regulator-0132.invalid/law', 'Article 4 states a limit of 91,16 grams per MJ. Article 5 follows.', 1, '2026-02-01T00:00:00Z');
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at)
      SELECT gen_random_uuid(), v_item, 'https://other-0132.invalid/page-' || g, 'Article 4 states a limit of 91,16 grams per MJ. Other page ' || g, 2 + g, '2026-03-01T00:00:00Z' FROM generate_series(1, 50) g;
    IF public.capture_holding_quote('https://regulator-0132.invalid/law', 'ARTICLE 4 STATES A LIMIT OF 91,16 GRAMS PER MJ.') IS DISTINCT FROM v_new THEN RAISE EXCEPTION '0132-capture-quote-narrowed: the newest holding capture was not returned'; END IF;
    IF public.capture_holding_quote('https://regulator-0132.invalid/law', 'Other page 7') IS NOT NULL THEN RAISE EXCEPTION '0132-capture-quote-narrowed: another URL''s capture backed the quote'; END IF;
    IF public.capture_holding_quote('https://regulator-0132.invalid/law', 'a limit of 99 grams') IS NOT NULL THEN RAISE EXCEPTION '0132-capture-quote-narrowed: a quote no capture holds was accepted'; END IF;
    IF public.capture_holding_quote('https://regulator-0132.invalid/law', '   ') IS NOT NULL OR public.capture_holding_quote('', 'x') IS NOT NULL THEN RAISE EXCEPTION '0132-capture-quote-narrowed: a blank input returned a capture'; END IF;
    -- The count: a twin of is_verbatim that counts its calls in a transaction-local setting (the same verdict as the rule); rolled back with the fixture. COST 1 gives it the planner cost of the inlined production function (cheap), the position that made the old body test every capture before the URL.
    EXECUTE $twin$
      CREATE OR REPLACE FUNCTION public.is_verbatim(p_capture text, p_span text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE COST 1 SET search_path TO 'public', 'pg_temp'
      AS $b$ BEGIN
        PERFORM set_config('caros.verbatim_calls', (coalesce(nullif(current_setting('caros.verbatim_calls', true), ''), '0')::int + 1)::text, true);
        RETURN p_capture IS NOT NULL AND p_span IS NOT NULL AND btrim(p_span, ' ') <> '' AND position(lower(btrim(p_span, ' ')) IN lower(p_capture)) > 0;
      END $b$ $twin$;
    -- The new index would hide the old body's defect (it narrows the scan by itself), so the count is taken with index and bitmap scans off: the function must narrow to the cited URL by its own shape.
    PERFORM set_config('enable_indexscan', 'off', true);
    PERFORM set_config('enable_bitmapscan', 'off', true);
    PERFORM set_config('caros.verbatim_calls', '0', true);
    IF public.capture_holding_quote('https://regulator-0132.invalid/law', 'Article 4 states a limit') IS DISTINCT FROM v_new THEN RAISE EXCEPTION '0132-capture-quote-narrowed: the counted call returned the wrong capture'; END IF;
    v_calls := current_setting('caros.verbatim_calls')::int;
    IF v_calls > 2 THEN RAISE EXCEPTION '0132-capture-quote-narrowed: the verbatim test ran on % captures; it may run on the 2 captures of the cited URL only', v_calls; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0132-capture-quote-narrowed: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0132-capture-quote-narrowed: rollback sentinel' THEN RAISE; END IF;
  END;
  RAISE NOTICE '0132-capture-quote-narrowed OK';
END $$;

COMMIT;
