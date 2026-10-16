-- every foreign key's leading column has a non-partial index
SELECT c.conrelid::regclass || ' (' || c.conname || ')' FROM pg_constraint c
 JOIN pg_namespace n ON n.oid = c.connamespace
 WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT EXISTS (
   SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NULL) ORDER BY 1;
