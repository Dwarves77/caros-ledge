-- Down for 0078_migration_log: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.migration_log;
