# supabase/schema.sql: edits against the 2026-10-12 production dump

Source: the production dump of 2026-10-12 (pg_dump 15.14, `--schema-only --no-owner --schema=public`), 23,291 lines.
This file: 23,286 lines. Line numbers below are dump line numbers.

| dump line | change | reason |
|---|---|---|
| 1-3 | removed (three leading comment lines) | the dump's own description; not part of the schema |
| 8 | `\restrict <key>` removed | psql meta-command, not SQL; named as a candidate failure cause in the old repo's schema register. Not tested here against an older psql |
| 23290 | `\unrestrict <key>` removed | the matching meta-command; removed with line 8 so the file contains no psql meta-command |

No SQL statement is edited. Stubs the dump needs (created by `scripts/ci/schema-apply.mjs` before the file is applied):

- roles `anon`, `authenticated`, `service_role`, `supabase_admin`, `reconciler` (NOLOGIN)
- schema `auth`: `users` table, `uid()`, `role()`
- schemas and extensions: scripts/ci/data/production-shape.json (read from production's catalog 2026-10-18; P2-15g). `schema-apply.mjs` creates ltree and pg_trgm in `public`, pgcrypto, uuid-ossp and pg_stat_statements in `extensions`, and an empty stub schema for every other production schema (cron, graphql, graphql_public, net, realtime, storage, supabase_migrations, vault); the Supabase-only extensions (pg_cron, pg_net, pgjwt, pgsodium, supabase_vault) are recorded, not installed. schema.sql has no CREATE EXTENSION line (the dump is `--schema=public`); its `CREATE SCHEMA public;` is applied as `IF NOT EXISTS` in memory because the extensions live there first
- schema `vault`: `decrypted_secrets` view
- schema `net`: `http_post()` function, `_http_response` table
- `DROP SCHEMA public CASCADE` before the apply, because line 28 of the original (`CREATE SCHEMA public;`) fails on an image that already has `public`. Dropping it in the harness keeps the dump unedited.

## P2-15d: the twelve `FOR ROLE supabase_admin` default-privilege statements

Dump lines 23236-23239, 23256-23259 and 23276-23279 (`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES|FUNCTIONS|TABLES TO postgres, anon, authenticated, service_role`) are removed: they are Supabase platform state, and the role migrations run as (`postgres`, not a member of supabase_admin) cannot set them (42501). `scripts/ci/schema-apply.mjs` re-creates them as the bootstrap superuser right after the file, so the CI catalog still equals production's.
