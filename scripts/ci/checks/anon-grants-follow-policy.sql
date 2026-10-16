-- anon holds SELECT only, and only on a relation with a SELECT policy anon can satisfy
SELECT 'anon holds ' || privilege_type || ' on ' || table_name FROM information_schema.role_table_grants
 WHERE grantee IN ('anon', 'PUBLIC') AND table_schema = 'public' AND privilege_type <> 'SELECT'
UNION ALL
SELECT 'anon SELECT without an anon policy: ' || c.relname FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege('anon', c.oid, 'SELECT')
   AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                    AND p.cmd IN ('SELECT', 'ALL') AND p.roles && ARRAY['public', 'anon']::name[])
ORDER BY 1;
