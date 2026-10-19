-- Down for 0017_census_would_mint_index: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP INDEX public.census_worklist_would_mint_idx;
