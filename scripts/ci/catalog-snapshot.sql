-- One line per catalog object in public, as "class|object|detail". Comments are left out on purpose. Read by schema-apply.mjs, which
-- diffs two snapshots per migration and compares the classes that changed with the classes the migration's header declares.
SELECT class, object, regexp_replace(detail, '[[:space:]]+', ' ', 'g') FROM (
  SELECT 'column' AS class, c.relname || '.' || a.attname AS object,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS detail
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'relation', c.relname, c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'constraint', c.conrelid::regclass || '.' || c.conname, pg_get_constraintdef(c.oid)
    FROM pg_constraint c WHERE c.connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'policy', tablename || '.' || policyname, cmd::text || ' ' || roles::text || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'trigger', t.tgrelid::regclass || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) || ' config=' || coalesce(p.proconfig::text, '') || ' acl=' || coalesce(p.proacl::text, '')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
  UNION ALL
  SELECT 'acl', c.relname, coalesce(c.relacl::text, '')
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'default_acl', pg_get_userbyid(defaclrole) || ' ' || defaclobjtype::text || ' ' || defaclnamespace::regnamespace, defaclacl::text FROM pg_default_acl
) s(class, object, detail) ORDER BY 1, 2, 3;
