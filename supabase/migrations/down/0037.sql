-- Down for 0037_item_write_rpcs: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.archive_item_for_team(uuid,uuid,text,text,jsonb);
DROP FUNCTION public.assign_item(uuid,uuid,uuid,jsonb);
