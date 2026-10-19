-- Down for 0038_load_settings_bundle: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.load_settings_bundle(uuid,uuid,integer);
