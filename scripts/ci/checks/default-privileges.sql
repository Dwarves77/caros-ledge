-- default privileges in every schema the app reads (and the schema-less function defaults) grant nothing to anon, authenticated or PUBLIC
SELECT DISTINCT pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text || ' in ' || coalesce(d.defaclnamespace::regnamespace::text, 'every schema') || ' default grants to ' ||
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid = a.grantee) END
  FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
 WHERE ((SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace) = ANY ({{schemas}}) OR (d.defaclnamespace = 0 AND d.defaclobjtype = 'f'))
   AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))) ORDER BY 1;
