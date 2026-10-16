-- no plpgsql or sql function body names a relation that does not exist (FROM, JOIN, UPDATE, INSERT INTO; CTEs, set-returning functions, assigned variables and parameters excluded)
SELECT DISTINCT r.sig || ' -> ' || r.qname FROM (
  SELECT p.oid::regprocedure::text AS sig, p.proargnames AS args, s.src, m[2] AS sch, lower(m[3]) AS rel,
         coalesce(m[2] || '.', '') || lower(m[3]) AS qname
    FROM pg_proc p
    CROSS JOIN LATERAL (SELECT regexp_replace(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '/\*.*?\*/', '', 'g'),
                                              '''([^'']|'''')*''', '''''', 'g') AS src) s
    CROSS JOIN LATERAL regexp_matches(s.src, '(?<!distinct\s)\m(from|join|update|insert\s+into)\s+(?:only\s+)?(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)', 'gi') AS m
   WHERE p.pronamespace = 'public'::regnamespace AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('plpgsql', 'sql'))
) r
WHERE r.rel NOT IN ('select', 'only', 'lateral', 'values', 'set')
  AND to_regclass(coalesce(quote_ident(r.sch) || '.', '') || quote_ident(r.rel)) IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc f WHERE f.proname = r.rel)
  AND r.rel <> ALL (coalesce(r.args, '{}'))
  AND r.src !~* ('\m' || r.rel || '\s*:=')
  AND NOT EXISTS (SELECT 1 FROM regexp_matches(r.src, '(\w+)\s*(?:\([^()]*\))?\s+as\s*(?:not\s+materialized\s*)?\(', 'gi') c WHERE lower(c[1]) = r.rel)
ORDER BY 1;
