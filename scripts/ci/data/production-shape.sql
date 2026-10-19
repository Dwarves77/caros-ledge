-- The part of a Supabase project's database that the CI database must be built to match (scripts/ci/schema/base.mjs), as ONE jsonb document. The same text is the body of public.live_check_production_shape()
-- (migration 0071): the live check calls it on the deployed project and compares the answer with the "shape" key of scripts/ci/data/production-shape.json, and the schema job calls it on the CI database and
-- compares the same way, so the file, the CI database and production cannot disagree without a red run. Read from production by scripts/cutover/read-production-shape.mjs.
-- A role the platform creates for a session (cli_login_*), the pg_* roles and the CI database's own bootstrap roles (ci_bootstrap*) are not part of the shape. A role setting's value is stored with or without a backslash
-- before a dollar sign depending on how it was set; the backslash is dropped so the same setting compares equal. An ACL is a list of its items sorted in the C collation (the order of grants is not meaningful, and a locale-aware sort puts `=U/owner` in a different place on a different server). `authUsers` is the columns of
-- auth.users and `authFunctions` the definitions of the functions every policy calls (auth.uid(), auth.role(), auth.jwt(), auth.email()): the CI database creates both from this document, never from a copy typed here.
SELECT jsonb_build_object(
  'databaseOwner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
  'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', rolname, 'super', rolsuper, 'inherit', rolinherit, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'login', rolcanlogin, 'replication', rolreplication, 'bypassrls', rolbypassrls, 'connlimit', rolconnlimit) ORDER BY rolname), '[]'::jsonb)
              FROM pg_roles WHERE rolname !~ '^(pg_|cli_login_|ci_bootstrap)'),
  'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object('role', r.rolname, 'member', m.rolname) ORDER BY r.rolname, m.rolname), '[]'::jsonb)
                    FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
                   WHERE r.rolname !~ '^(pg_|cli_login_|ci_bootstrap)' AND m.rolname !~ '^(pg_|cli_login_|ci_bootstrap)'),
  'roleSettings', (SELECT coalesce(jsonb_agg(jsonb_build_object('role', coalesce(r.rolname, '*'), 'database', coalesce(d.datname, '*'), 'settings', ARRAY(SELECT replace(c, chr(92), '') FROM unnest(s.setconfig) c)) ORDER BY coalesce(r.rolname, '*'), coalesce(d.datname, '*')), '[]'::jsonb)
                     FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase
                    WHERE coalesce(r.rolname, '') !~ '^(cli_login_|ci_bootstrap)' AND coalesce(d.datname, current_database()) = current_database()),
  'schemaAcls', (SELECT coalesce(jsonb_agg(jsonb_build_object('schema', nspname, 'owner', pg_get_userbyid(nspowner), 'acl', ARRAY(SELECT x::text FROM unnest(nspacl) x ORDER BY x::text COLLATE "C")) ORDER BY nspname), '[]'::jsonb)
                   FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'),
  'defaultAcls', (SELECT coalesce(jsonb_agg(jsonb_build_object('role', pg_get_userbyid(defaclrole), 'schema', CASE WHEN defaclnamespace = 0 THEN '*' ELSE defaclnamespace::regnamespace::text END, 'objtype', defaclobjtype::text, 'acl', ARRAY(SELECT x::text FROM unnest(defaclacl) x ORDER BY x::text COLLATE "C"))
                                            ORDER BY pg_get_userbyid(defaclrole), CASE WHEN defaclnamespace = 0 THEN '*' ELSE defaclnamespace::regnamespace::text END, defaclobjtype::text), '[]'::jsonb) FROM pg_default_acl),
  'authUsers', (SELECT coalesce(jsonb_agg(jsonb_build_object('column', column_name, 'type', data_type, 'nullable', is_nullable = 'YES') ORDER BY ordinal_position), '[]'::jsonb) FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users'),
  'authFunctions', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', p.proname, 'definition', pg_get_functiondef(p.oid)) ORDER BY p.proname), '[]'::jsonb) FROM pg_proc p WHERE p.pronamespace = 'auth'::regnamespace AND p.proname IN ('uid', 'role', 'jwt', 'email')),
  'serverSettings', (SELECT coalesce(jsonb_object_agg(name, setting ORDER BY name), '{}'::jsonb) FROM pg_settings
                      WHERE name IN ('row_security', 'default_transaction_isolation', 'standard_conforming_strings'))
) AS shape
