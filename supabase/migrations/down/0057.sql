-- Down for 0057_moderate_report: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.moderate_report(uuid,text,text);
