-- Down for 0068_live_check_provenance_trigger: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.live_check_provenance_trigger();
