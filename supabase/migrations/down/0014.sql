-- Down for 0014_screen_verdicts: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.screen_verdicts;
