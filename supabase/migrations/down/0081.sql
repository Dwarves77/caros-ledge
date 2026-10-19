-- Down for 0081_register_source_once: the function, the unique index and the key column go; the registry returns to identity by url alone.
DROP FUNCTION public.register_source_once(text, jsonb);
DROP INDEX public.sources_institution_key_uniq;
ALTER TABLE public.sources DROP COLUMN institution_key;
