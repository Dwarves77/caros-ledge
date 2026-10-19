-- Down for 0032_saved_views: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.saved_views;
