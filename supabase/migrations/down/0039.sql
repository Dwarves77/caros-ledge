-- Down for 0039_theme_brief_versions: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER theme_briefs_keep_version ON public.theme_briefs;
DROP FUNCTION public.theme_briefs_keep_version();
DROP TABLE public.theme_brief_versions;
