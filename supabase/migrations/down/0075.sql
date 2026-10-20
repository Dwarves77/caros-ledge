-- Down for 0075: the theme-brief apply function goes; theme_briefs, theme_brief_versions and their trigger (0039) are untouched.
DROP FUNCTION public.apply_theme_brief(uuid, text, text, text, jsonb, jsonb, text, timestamptz);
