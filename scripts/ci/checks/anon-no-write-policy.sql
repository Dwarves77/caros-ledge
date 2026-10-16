-- no policy grants INSERT, UPDATE or DELETE to anon
SELECT tablename || '.' || policyname FROM pg_policies
 WHERE schemaname = 'public' AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
   AND (roles && ARRAY['anon','public']::name[]) ORDER BY 1;
