-- anon holds SELECT only, and only on a relation with a SELECT policy anon can satisfy (every schema the app reads)
SELECT 'anon holds ' || privilege_type || ' on ' || table_schema || '.' || table_name FROM information_schema.role_table_grants
 WHERE grantee IN ('anon', 'PUBLIC') AND table_schema::name = ANY ({{schemas}}) AND privilege_type <> 'SELECT'
UNION ALL
SELECT 'anon SELECT without an anon policy: ' || n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY ({{schemas}}) AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege('anon', c.oid, 'SELECT')
   AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname
                    AND p.cmd IN ('SELECT', 'ALL') AND p.roles && ARRAY['public', 'anon']::name[])
ORDER BY 1;
