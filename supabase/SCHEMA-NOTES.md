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
- schema `extensions` with `pgcrypto`
- schema `vault`: `decrypted_secrets` view
- schema `net`: `http_post()` function, `_http_response` table
- `DROP SCHEMA public CASCADE` before the apply, because line 28 of the original (`CREATE SCHEMA public;`) fails on an image that already has `public`. Dropping it in the harness keeps the dump unedited.
