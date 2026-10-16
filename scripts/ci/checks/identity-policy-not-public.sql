-- no SELECT policy names PUBLIC on a table anon cannot read (it needs an identity: TO authenticated)
SELECT c.relname || '.' || p.polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
 WHERE c.relnamespace = 'public'::regnamespace AND p.polcmd = 'r' AND p.polroles = '{0}'
   AND NOT has_table_privilege('anon', c.oid, 'SELECT') ORDER BY 1;
