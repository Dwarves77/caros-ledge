-- Down for 0020_profiles_email_lower_index: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP INDEX public.profiles_email_lower_idx;
DROP FUNCTION public.profiles_by_email(text);
