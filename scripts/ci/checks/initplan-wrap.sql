-- every policy wraps auth.uid() and auth.role() in an initplan: (select auth.uid())
SELECT tablename || '.' || policyname FROM pg_policies
 WHERE schemaname = 'public'
   AND regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\( SELECT auth\.(uid|role)\(\) AS (uid|role)\)', '', 'g') ~ 'auth\.(uid|role)\(\)'
 ORDER BY 1;
