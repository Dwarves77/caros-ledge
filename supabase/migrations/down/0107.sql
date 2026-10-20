-- Down for 0107: the previous body of canonicalize_citation_url (the whole string lower-cased) comes back and the two form helpers go.
CREATE OR REPLACE FUNCTION public.canonicalize_citation_url(u text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $_$
  SELECT regexp_replace(                                -- ONE combined trailing-junk strip: slash + dots +
    regexp_replace(                                     -- punct, so `…/path/.*` (after marker strip `…/path/.`)
      regexp_replace(lower(btrim(u)), '[*`]+$', ''),    -- fully normalizes to `…/path`. strip trailing markers,
      '^(https?://)www\.', '\1'                         -- then leading www., then the combined trailing class.
    ),
    '[/.,;:]+$', ''
  );
$_$;
DROP FUNCTION public.canonical_form_decode(text);
DROP FUNCTION public.canonical_form_encode(text);
