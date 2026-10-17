// Applies supabase/schema.sql, then every supabase/migrations/NNNN_*.sql in name order (files named *_data_* are cutover-window data
// migrations: never committed here; each is run once after the schema files, after the fixture its `-- rollback-test:` header names,
// inside a transaction that rolls back, so its SQL is proven to execute and the catalog is unchanged), to an empty Postgres (DATABASE_URL) with the Supabase stubs it needs. Every error is printed
// with its line and any one stops the run. Then: the property checks against the live catalog, and the catalog diff: one
// snapshot per step, each migration's changed object classes equal to the classes its `-- catalog:` header declares, the final
// catalog equal to the last step's (the checks' planted violations leave nothing behind), and src/core/db/schema-keys.json equal
// to the live primary keys, and the generator pins (scripts/ci/checks/generator-pins.mjs). Exit 1 on any error or unexplained difference.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { renderJsonData } from "../gen/json-data.mjs";
import { readSchema } from "../gen/test-schema.mjs";

import { migrationProblems } from "./migration-checks.mjs";
import { psql as runSql } from "./psql.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Static checks, before any database work (scripts/ci/migration-checks.mjs).
const staticProblems = migrationProblems();
for (const p of staticProblems) console.error(p);
if (staticProblems.length) process.exit(1);

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

function psql(opts) {
  const r = runSql(url, opts);
  return { code: r.status, err: r.stderr, out: r.stdout };
}

function errorsOf(text) {
  return text.split("\n").filter((l) => /ERROR|FATAL/.test(l));
}

function apply(stopOnError) {
  const stub = psql({ sql: STUBS });
  if (stub.code !== 0) return { code: stub.code, errors: errorsOf(stub.err) };
  const r = psql({ file: "supabase/schema.sql", stopOnError });
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
  const r = psql({ file: "scripts/ci/catalog-snapshot.sql", tuples: true, sep: "|" });
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
  const m = psql({ file: path });
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
  if (off.length) {
    // The differing snapshot lines of an unexplained step (class|object|detail), removed then added, so a red run names the objects and not only the classes.
    const [sb, sa] = [new Set(before), new Set(after)];
    const lines = [...before.filter((l) => !sa.has(l)).map((l) => `  - ${l}`), ...after.filter((l) => !sb.has(l)).map((l) => `  + ${l}`)];
    for (const l of lines.slice(0, 40)) console.log(l.slice(0, 300));
    if (lines.length > 40) console.log(`  ... ${lines.length - 40} more differing line(s)`);
  }
  before = after;
}
console.log("migrations applied with zero errors");

const rollbackTest = (name, text) => {
  const fixture = text.match(/^-- rollback-test: (\S+)$/m)?.[1];
  if (!fixture) {
    console.error(`${name}: a _data_ migration needs a "-- rollback-test: <fixture>" header`);
    process.exit(1);
  }
  const body = text.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, ""); // the job owns the transaction: its ROLLBACK must undo the file's own COMMIT
  const r = psql({ sql: ["BEGIN;", readFileSync(fixture, "utf8"), body, "ROLLBACK;", ""].join("\n") });
  for (const l of r.err.split("\n")) if (/NOTICE/.test(l)) console.log(l.replace(/^.*NOTICE:\s*/, "  self-check: ").slice(0, 220));
  if (r.code !== 0 || errorsOf(r.err).length) {
    console.error(`${name}: failed in its rollback-test\n${r.err}`);
    process.exit(1);
  }
  const drifted = diff(before, snapshot());
  console.log(`${name}: ran after ${fixture} and rolled back${drifted.length ? ` UNEXPLAINED catalog change [${drifted.slice(0, 3)}]` : ""}`);
  unexplained += drifted.length;
};
for (const file of readdirSync("supabase/migrations").filter((f) => /^\d{4}_data_.+\.sql$/.test(f)).sort()) rollbackTest(file, readFileSync(`supabase/migrations/${file}`, "utf8"));
// The 0016 source backfill is generated at the cutover window from a live registry export, so no file is committed: the generator's own output for the sample export is proven every run.
const gen = spawnSync("node", ["--import", "./tests/_support/register.mjs", "scripts/gen/source-backfill-sql.mjs", "scripts/ci/fixtures/sources-export-sample.json", "the sample export"], { encoding: "utf8", maxBuffer: 1 << 26 });
if (gen.status !== 0 || !gen.stdout) {
  console.error(`source-backfill generator failed\n${gen.stderr}`);
  process.exit(1);
}
rollbackTest("generated source backfill (sample export)", gen.stdout);

const props = spawnSync("node", ["scripts/ci/properties.mjs"], { stdio: "inherit", env: process.env });
// IMP-037: the four SQL generators of src/core/contracts must equal what the schema applied (run through the register hook that resolves "@/").
const pins = spawnSync("node", ["--import", "./tests/_support/register.mjs", "scripts/ci/checks/generator-pins.mjs"], { stdio: "inherit", env: process.env });
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
const committedSchema = readFileSync("tests/_support/schema.json", "utf8").replace(/\r\n/g, "\n");
const schemaDiff = renderJsonData(readSchema(url)) === committedSchema ? 0 : 1;
if (schemaDiff) console.error("tests/_support/schema.json differs from the live catalog: run `DATABASE_URL=... node scripts/gen/test-schema.mjs` and commit the result");
console.log(`catalog diff: ${diff(step0, last).length} object changes across the migrations, ${unexplained} unexplained class(es), ${drift.length} drifted after the checks, ${keyDiff.length} schema-keys difference(s), ${schemaDiff} test-schema difference(s)`);
process.exit((props.status ?? 1) || (pins.status ?? 1) || unexplained || drift.length || keyDiff.length || schemaDiff ? 1 : 0);
