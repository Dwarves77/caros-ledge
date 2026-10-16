-- every SECURITY DEFINER function has search_path pinned
SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) s WHERE s LIKE 'search_path=%') ORDER BY 1;
