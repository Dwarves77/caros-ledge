-- default privileges grant nothing to anon, authenticated or PUBLIC
SELECT pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text || ' default grants to ' ||
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid = a.grantee) END
  FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
 WHERE a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) ORDER BY 1;
