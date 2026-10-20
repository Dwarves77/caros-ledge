-- Down for 0112_item_impact_scores: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.item_impact_scores;
