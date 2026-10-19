-- Down for 0065_assign_item_members: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.assign_item_members(uuid,uuid,uuid[],date,jsonb);
