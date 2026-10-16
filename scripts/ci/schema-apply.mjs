// Applies supabase/schema.sql, then every supabase/migrations/NNNN_*.sql in name order (files named *_data_* are cutover-window data
// migrations: never committed here; each is run once after the schema files, after the fixture its `-- rollback-test:` header names,
// inside a transaction that rolls back, so its SQL is proven to execute and the catalog is unchanged), to an empty Postgres (DATABASE_URL) with the Supabase stubs it needs. Every error is printed
// with its line and any one stops the run. Then: the property checks against the live catalog, and the catalog diff: one
// snapshot per step, each migration's changed object classes equal to the classes its `-- catalog:` header declares, the final
// catalog equal to the last step's (the checks' planted violations leave nothing behind), and src/core/db/schema-keys.json equal
// to the live primary keys. Exit 1 on any error or unexplained difference.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

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
  return { code: r.status ?? 1, err: r.stderr ?? "", out: r.stdout ?? "" };
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

const snapshot = () => {
  const r = psql(["-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-f", "scripts/ci/catalog-snapshot.sql"]);
  if (r.code !== 0) {
    console.error(r.err);
    process.exit(1);
  }
  return r.out.split("\n").filter(Boolean);
};
const diff = (a, b) => {
  const [sa, sb] = [new Set(a), new Set(b)];
  return [...b.filter((l) => !sa.has(l)), ...a.filter((l) => !sb.has(l))];
};

const step0 = snapshot();
let before = step0;
let unexplained = 0;
for (const file of readdirSync("supabase/migrations").filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.includes("_data_")).sort()) {
  const path = `supabase/migrations/${file}`;
  const m = psql(["-v", "ON_ERROR_STOP=1", "-f", path]);
  for (const l of m.err.split("\n")) if (/NOTICE/.test(l)) console.log(l.replace(/^.*NOTICE:\s*/, "  self-check: "));
  if (m.code !== 0 || errorsOf(m.err).length) {
    console.error(`${file}: failed\n${m.err}`);
    process.exit(1);
  }
  const after = snapshot();
  const changed = new Set(diff(before, after).map((l) => l.split("|")[0]));
  const declared = new Set((readFileSync(path, "utf8").match(/^-- catalog: (.*)$/m)?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== "none"));
  const off = [...changed].filter((c) => !declared.has(c)).concat([...declared].filter((c) => !changed.has(c)).map((c) => `declared but unchanged: ${c}`));
  console.log(`${file}: changed [${[...changed].sort()}]${off.length ? ` UNEXPLAINED [${off}]` : ""}`);
  unexplained += off.length;
  before = after;
}
console.log("migrations applied with zero errors");

for (const file of readdirSync("supabase/migrations").filter((f) => /^\d{4}_data_.+\.sql$/.test(f)).sort()) {
  const text = readFileSync(`supabase/migrations/${file}`, "utf8");
  const fixture = text.match(/^-- rollback-test: (\S+)$/m)?.[1];
  if (!fixture) {
    console.error(`${file}: a _data_ migration needs a "-- rollback-test: <fixture>" header`);
    process.exit(1);
  }
  const body = text.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, ""); // the job owns the transaction: its ROLLBACK must undo the file's own COMMIT
  const r = psql(["-v", "ON_ERROR_STOP=1"], ["BEGIN;", readFileSync(fixture, "utf8"), body, "ROLLBACK;", ""].join("\n"));
  for (const l of r.err.split("\n")) if (/NOTICE/.test(l)) console.log(l.replace(/^.*NOTICE:\s*/, "  self-check: ").slice(0, 220));
  if (r.code !== 0 || errorsOf(r.err).length) {
    console.error(`${file}: failed in its rollback-test\n${r.err}`);
    process.exit(1);
  }
  const drifted = diff(before, snapshot());
  console.log(`${file}: ran after ${fixture} and rolled back${drifted.length ? ` UNEXPLAINED catalog change [${drifted.slice(0, 3)}]` : ""}`);
  unexplained += drifted.length;
}

const props = spawnSync("node", ["scripts/ci/properties.mjs"], { stdio: "inherit", env: process.env });
const last = snapshot();
const drift = diff(before, last);
for (const l of drift.slice(0, 20)) console.error(`unexplained after the property checks: ${l}`);
const live = {};
for (const l of last) {
  const [cls, obj, def] = l.split("|");
  const pk = cls === "constraint" && def.match(/^PRIMARY KEY \((.*)\)$/);
  if (pk) live[obj.split(".")[0]] = pk[1].split(",").map((c) => c.trim());
}
const keys = JSON.parse(readFileSync("src/core/db/schema-keys.json", "utf8"));
const keyDiff = [...new Set([...Object.keys(live), ...Object.keys(keys)])].filter((t) => JSON.stringify(live[t]) !== JSON.stringify(keys[t]));
for (const t of keyDiff) console.error(`schema-keys.json differs from the live primary key of ${t}: ${JSON.stringify(keys[t])} vs ${JSON.stringify(live[t])}`);
console.log(`catalog diff: ${diff(step0, last).length} object changes across the migrations, ${unexplained} unexplained class(es), ${drift.length} drifted after the checks, ${keyDiff.length} schema-keys difference(s)`);
process.exit((props.status ?? 1) || unexplained || drift.length || keyDiff.length ? 1 : 0);
