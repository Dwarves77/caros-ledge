-- Down for 0052_community_group_keeps_an_admin: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER community_group_keeps_an_admin_trg ON public.community_group_members;
DROP FUNCTION public.community_group_keeps_an_admin();
