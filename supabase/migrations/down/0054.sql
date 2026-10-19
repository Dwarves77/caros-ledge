-- Down for 0054_accept_group_invitation: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.accept_group_invitation(uuid);
