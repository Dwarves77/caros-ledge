-- expect: postgres r in public default grants to anon
-- expect: postgres r in public default grants to authenticated
-- expect: postgres r in planted_schema default grants to anon
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
CREATE SCHEMA planted_schema;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA planted_schema GRANT SELECT ON TABLES TO anon;
