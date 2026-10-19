-- Down for 0058_community_directory_counts: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.community_directory_counts();
