-- Down for 0013_fire_signpost: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.fire_signpost(text,timestamp with time zone,text);
