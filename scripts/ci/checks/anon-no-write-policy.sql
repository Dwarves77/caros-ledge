-- no policy grants INSERT, UPDATE or DELETE to anon (every schema the app reads)
SELECT schemaname || '.' || tablename || '.' || policyname FROM pg_policies
 WHERE schemaname = ANY ({{schemas}}) AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
   AND (roles && ARRAY['anon','public']::name[]) ORDER BY 1;
