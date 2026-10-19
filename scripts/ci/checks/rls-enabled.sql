-- RLS enabled on every table in a schema the app reads
SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY ({{schemas}}) AND c.relkind IN ('r','p') AND NOT c.relrowsecurity ORDER BY 1;
