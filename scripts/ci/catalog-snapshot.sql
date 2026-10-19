-- One line per catalog object, as "class|object|detail". Comments are left out on purpose. Read by schema-apply.mjs, which diffs two snapshots per migration and compares the classes that changed with the classes the migration's
-- header declares (`-- catalog:`), and compares the snapshot after a down file with the one before its migration.
-- ACLs are listed sorted (the order of grants is not meaningful and a down file cannot reproduce it).
-- Classes: column, relation (kind, RLS, and for a view the md5 and length of its definition: a view body can change under a declaration of `relation` only), constraint, index, policy, trigger, function (definition md5, config, ACL),
-- acl (table ACL and every column ACL), default_acl, type (enums and domains), extension, schema_acl (every schema outside the system ones). Objects in `public` unless the class says otherwise.
SELECT class, object, regexp_replace(detail, '[[:space:]]+', ' ', 'g') FROM (
  SELECT 'column' AS class, c.relname || '.' || a.attname AS object,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS detail
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'relation', c.relname, c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
         || CASE WHEN c.relkind IN ('v', 'm') THEN ' def=' || md5(pg_get_viewdef(c.oid)) || '/' || length(pg_get_viewdef(c.oid)) ELSE '' END
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
  SELECT 'function', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) || ' config=' || coalesce(p.proconfig::text, '') || ' acl=' || coalesce((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(p.proacl) x), '')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
  UNION ALL
  SELECT 'acl', c.relname, coalesce((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(c.relacl) x), '') || coalesce((SELECT ' ' || string_agg(a.attname || '=' || (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(a.attacl) x), ' ' ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL AND NOT a.attisdropped), '')
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'default_acl', pg_get_userbyid(defaclrole) || ' ' || defaclobjtype::text || ' ' || defaclnamespace::regnamespace, (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(defaclacl) x) FROM pg_default_acl
  UNION ALL
  SELECT 'type', t.typname, t.typtype::text || ' ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') || coalesce(' ' || pg_get_constraintdef((SELECT c.oid FROM pg_constraint c WHERE c.contypid = t.oid LIMIT 1)), '')
    FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd')
  UNION ALL
  SELECT 'extension', e.extname, e.extversion || ' ' || e.extnamespace::regnamespace FROM pg_extension e
  UNION ALL
  SELECT 'schema_acl', n.nspname, pg_get_userbyid(n.nspowner) || ' ' || coalesce((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(n.nspacl) x), '') FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
) s(class, object, detail) ORDER BY 1, 2, 3;
