-- Down for 0111_item_obligation_scan: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.item_obligation_scan;
