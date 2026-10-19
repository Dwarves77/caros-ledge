-- Down for 0050_community_group_bans: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER community_group_members_ban_guard_trg ON public.community_group_members;
DROP FUNCTION public.community_group_members_ban_guard();
DROP TABLE public.community_group_bans;
