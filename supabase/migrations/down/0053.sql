-- Down for 0053_create_group_for_self: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.create_group_for_self(text,text,text,text);
