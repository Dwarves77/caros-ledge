-- no trigger function and no invoker function that writes is executable by anon, authenticated or PUBLIC (every schema the app reads)
-- Exception: patch_workspace_settings (migration 0023) is SECURITY INVOKER, so the caller's own RLS on workspace_settings decides who may write, and the client calls it on purpose.
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = ANY ({{schemas}}) AND p.prokind = 'f'
   AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   AND p.proname <> 'patch_workspace_settings'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') -- an extension's function is not ours
   AND (p.prorettype = 'trigger'::regtype
        OR (NOT p.prosecdef AND p.prosrc ~* '(insert[[:space:]]+into|delete[[:space:]]+from|update[[:space:]]+[a-z_.]+([[:space:]]+[a-z_]+)?[[:space:]]+set)'))
 ORDER BY 1;
