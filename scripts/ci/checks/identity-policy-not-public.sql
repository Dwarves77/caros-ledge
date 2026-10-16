-- no SELECT policy names PUBLIC on a table anon cannot read (it needs an identity: TO authenticated)
SELECT p.tablename || '.' || p.policyname FROM pg_policies p
 WHERE p.schemaname = 'public' AND p.cmd = 'SELECT' AND p.roles = '{public}'
   AND NOT has_table_privilege('anon', format('public.%I', p.tablename), 'SELECT') ORDER BY 1;
