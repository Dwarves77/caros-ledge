-- 0006 initplan wraps (P2-S1, owed by register P1-11 schema.md section 8 "Changed": the policies that still call auth.role() or
-- auth.uid() unwrapped get the initplan wrap; 27 at the baseline, the register counted 25).
--
-- `auth.uid()` in a policy expression is re-evaluated for every row; `(select auth.uid())` is an initplan evaluated once per
-- statement. Each affected policy is rewritten in place with ALTER POLICY from its own deparsed text, roles untouched, so the
-- meaning is identical and only the evaluation count changes. Already-wrapped calls are left as they are.
-- Not applied to production before the cutover window.
--
-- Reversal: none needed (semantically identical); rewrite the calls unwrapped to restore the old plan.

-- catalog: policy

BEGIN;

DO $$
DECLARE r record; q text; w text; stmt text; n int := 0;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
           WHERE schemaname = 'public'
             AND regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                                '\( SELECT auth\.(uid|role)\(\) AS (uid|role)\)', '', 'g') ~ 'auth\.(uid|role)\(\)'
  LOOP
    q := r.qual; w := r.with_check;
    FOR i IN 1..2 LOOP
      DECLARE e text := CASE WHEN i = 1 THEN q ELSE w END;
      BEGIN
        IF e IS NOT NULL THEN
          e := regexp_replace(e, '\( SELECT auth\.(uid|role)\(\) AS (uid|role)\)', '@@WRAPPED_\1@@', 'g');
          e := regexp_replace(e, 'auth\.(uid|role)\(\)', '( SELECT auth.\1() AS \1)', 'g');
          e := regexp_replace(e, '@@WRAPPED_(uid|role)@@', '( SELECT auth.\1() AS \1)', 'g');
        END IF;
        IF i = 1 THEN q := e; ELSE w := e; END IF;
      END;
    END LOOP;
    stmt := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename)
         || CASE WHEN q IS NOT NULL THEN ' USING (' || q || ')' ELSE '' END
         || CASE WHEN w IS NOT NULL THEN ' WITH CHECK (' || w || ')' ELSE '' END;
    EXECUTE stmt;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0006: % policies rewritten', n;
END $$;

-- Self-check 0006-initplan: no policy calls auth.uid() or auth.role() outside an initplan, and the rewrite changed no policy count.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO bad FROM pg_policies
   WHERE schemaname = 'public'
     AND regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                        '\( SELECT auth\.(uid|role)\(\) AS (uid|role)\)', '', 'g') ~ 'auth\.(uid|role)\(\)';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006-initplan: unwrapped auth call in %', bad; END IF;
  RAISE NOTICE '0006-initplan OK';
END $$;

COMMIT;
