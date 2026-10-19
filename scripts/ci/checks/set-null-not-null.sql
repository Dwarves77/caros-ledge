-- no ON DELETE SET NULL onto a column that is NOT NULL or that a CHECK requires non-null (every schema the app reads)
SELECT c.conrelid::regclass || '.' || a.attname || ' (' || c.conname || ')'
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
 WHERE c.contype = 'f' AND c.confdeltype = 'n' AND c.connamespace IN (SELECT oid FROM pg_namespace WHERE nspname = ANY ({{schemas}}))
   AND (a.attnotnull OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.conrelid AND k.contype = 'c'
        AND a.attnum = ANY (k.conkey) AND pg_get_constraintdef(k.oid) LIKE '%' || a.attname || ' IS NOT NULL%')) ORDER BY 1;
