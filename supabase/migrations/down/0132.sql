-- Down for 0132_capture_quote_narrowed_and_indexed: the 0106 body of capture_holding_quote comes back, then the index goes.
CREATE OR REPLACE FUNCTION public.capture_holding_quote(p_url text, p_quote text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT a.id
    FROM public.agent_run_searches a
   WHERE coalesce(btrim(p_quote), '') <> '' AND coalesce(p_url, '') <> ''
     AND a.result_url ILIKE '%' || public.ledger_host_of(p_url) || '%'
     AND public.canonicalize_citation_url(a.result_url) = public.canonicalize_citation_url(p_url)
     AND a.result_content IS NOT NULL AND public.is_verbatim(a.result_content, p_quote)
   ORDER BY a.searched_at DESC NULLS LAST, a.id
   LIMIT 1
$$;
DROP INDEX public.agent_run_searches_canonical_url_idx;
