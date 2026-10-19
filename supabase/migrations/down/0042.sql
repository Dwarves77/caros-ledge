-- Down for 0042_host_verdicts: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.host_verdicts;
