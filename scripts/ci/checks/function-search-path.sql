-- every function in a schema the app reads has search_path pinned
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = ANY ({{schemas}})
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') -- an extension's function (ltree, pg_trgm on production) is not ours
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) s WHERE s LIKE 'search_path=%') ORDER BY 1;
