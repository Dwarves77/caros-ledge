-- Down for 0024_tag_counts_and_org_watchers: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.org_watchers(uuid,text[]);
DROP VIEW public.workspace_tag_counts;
