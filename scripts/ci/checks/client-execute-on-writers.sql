-- no trigger function and no invoker function that writes is executable by anon, authenticated or PUBLIC
-- Exception: patch_workspace_settings (migration 0023) is SECURITY INVOKER, so the caller's own RLS on workspace_settings decides who may write, and the client calls it on purpose.
SELECT p.oid::regprocedure::text FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   AND p.proname <> 'patch_workspace_settings'
   AND (p.prorettype = 'trigger'::regtype
        OR (NOT p.prosecdef AND p.prosrc ~* '(insert[[:space:]]+into|delete[[:space:]]+from|update[[:space:]]+[a-z_.]+([[:space:]]+[a-z_]+)?[[:space:]]+set)'))
 ORDER BY 1;
