-- Down for 0055_create_thread: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.create_thread(uuid,text,text,boolean,text[]);
