-- Down for 0027_edge_snapshots: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.edge_snapshots;
