// Applies supabase/schema.sql to an empty Postgres (DATABASE_URL) with the Supabase stubs it needs,
// prints every error with its line, then runs the property checks. Exit 1 on any error.
import { spawnSync } from "node:child_process";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const STUBS = `
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','supabase_admin','reconciler'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text $f$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT NULL::uuid AS id, NULL::text AS name, NULL::text AS decrypted_secret WHERE false;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net._http_response (id bigint, status_code int, content text);
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $f$ SELECT 0::bigint $f$;
DROP SCHEMA IF EXISTS public CASCADE;
`;

function psql(args, input) {
  const r = spawnSync("psql", [url, "-X", "-q", ...args], { encoding: "utf8", maxBuffer: 1 << 28, input });
  return { code: r.status ?? 1, err: r.stderr ?? "" };
}

function errorsOf(text) {
  return text.split("\n").filter((l) => /ERROR|FATAL/.test(l));
}

function apply(stopOnError) {
  const stub = psql(["-v", "ON_ERROR_STOP=1"], STUBS);
  if (stub.code !== 0) return { code: stub.code, errors: errorsOf(stub.err) };
  const r = psql(["-v", `ON_ERROR_STOP=${stopOnError ? 1 : 0}`, "-f", "supabase/schema.sql"]);
  const errors = errorsOf(r.err);
  return { code: r.code !== 0 || errors.length ? 1 : 0, errors };
}

let result = apply(true);
if (result.code !== 0) {
  // ON_ERROR_STOP shows only the first failure; a second pass without it lists every one.
  result = apply(false);
  console.error(`schema.sql: ${result.errors.length} error(s)`);
  for (const e of result.errors) console.error(e);
  process.exit(1);
}
console.log("schema.sql applied with zero errors");

const props = spawnSync("node", ["scripts/ci/properties.mjs"], { stdio: "inherit", env: process.env });
process.exit(props.status ?? 1);
