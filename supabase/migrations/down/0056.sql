-- Down for 0056_decide_signoff: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.decide_signoff(uuid,text,text,text);
