// The schema job. Against an empty Postgres (DATABASE_URL) it
//   1. runs the static migration checks (scripts/ci/migration-checks.mjs);
//   2. builds the Supabase project the migrations are written for from the production shape and applies supabase/schema.sql (scripts/ci/schema/base.mjs);
//   3. applies every supabase/migrations/NNNN_*.sql in name order (scripts/ci/schema/chain.mjs): each prints its own self-check OK, changes exactly the catalog classes its header declares, and its down file returns the catalog to
//      where it was; then each `_data_` file once, after its fixture, in a transaction that rolls back (scripts/ci/schema/data.mjs);
//   4. runs the property checks, the generator pins, and compares the finished catalog with the last step's, src/core/db/schema-keys.json with the live primary keys, tests/_support/schema.json with the live columns, and
//      the database's shape (roles, settings, ACLs) with the production shape.
// Exit 1 on any error or unexplained difference.
//   node scripts/ci/schema-apply.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { renderJsonData } from "../gen/json-data.mjs";
import { readSchema } from "../gen/test-schema.mjs";

import { migrationProblems } from "./migration-checks.mjs";
import { applyBase, openDatabase, shapeProblems } from "./schema/base.mjs";
import { diff, runChain, snapshot } from "./schema/chain.mjs";
import { runDataFiles } from "./schema/data.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const fail = (problems) => {
  for (const p of problems) console.error(p);
  process.exit(1);
};

// Static checks, before any database work.
const staticProblems = migrationProblems();
if (staticProblems.length) fail(staticProblems);

const ctx = await openDatabase(process.env.DATABASE_URL);
process.env.DATABASE_URL = ctx.url; // the property checks, generator pins and test-schema reader that follow connect as the same production-shaped role

let result = applyBase(ctx, true);
if (result.code !== 0) {
  // ON_ERROR_STOP shows only the first failure; a second pass without it lists every one.
  result = applyBase(ctx, false);
  console.error(`schema.sql: ${result.errors.length} error(s)`);
  fail(result.errors);
}
console.log("schema.sql applied with zero errors");

const step0 = snapshot(ctx);
// IMP-058: the window's duplicate-email query is proven right before 0066 (the unique index makes a duplicate impossible after it): it returns nothing on a clean table and exactly the planted address when two accounts differ only in case.
function proveDuplicateEmailQuery() {
  const query = readFileSync("scripts/cutover/duplicate-emails.sql", "utf8");
  const clean = ctx.psql({ sql: query, tuples: true });
  const planted = ctx.psql({ sql: `BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'Dup.Planted@invalid.example'), (gen_random_uuid(), 'dup.planted@invalid.example');
${query}
ROLLBACK;`, tuples: true });
  const ok = clean.code === 0 && clean.out.trim() === "" && planted.code === 0 && planted.out.trim() === "dup.planted@invalid.example|2";
  console.log(`duplicate-emails.sql: ${ok ? "returns nothing on a clean table and the planted pair when two accounts differ only in case" : `FAILED (clean: ${JSON.stringify(clean.out)}, planted: ${JSON.stringify(planted.out)} ${planted.err.trim()})`}`);
  if (!ok) process.exit(1);
}

const chain = runChain(ctx, { hooks: { before: (file) => { if (file.startsWith("0066_")) proveDuplicateEmailQuery(); } } });
if (chain.problems.length) fail(chain.problems);
console.log("migrations applied with zero errors");

const dataProblems = runDataFiles(ctx, { before: chain.last });
if (dataProblems.length) fail(dataProblems);

const props = spawnSync("node", ["scripts/ci/properties.mjs"], { stdio: "inherit", env: process.env });
// IMP-037: the four SQL generators of src/core/contracts must equal what the schema applied (run through the register hook that resolves "@/").
const pins = spawnSync("node", ["--import", "./tests/_support/register.mjs", "scripts/ci/checks/generator-pins.mjs"], { stdio: "inherit", env: process.env });
// G11: the in-memory database every test runs over answers filters and the 1000-row cut as this database does.
const memdb = spawnSync("node", ["--import", "./tests/_support/register.mjs", "scripts/ci/checks/memdb-conformance.mjs"], { stdio: "inherit", env: process.env });
const last = snapshot(ctx);
const drift = diff(chain.last, last);
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
const schemaDiff = renderJsonData(readSchema(ctx.url)) === committedSchema ? 0 : 1;
if (schemaDiff) console.error("tests/_support/schema.json differs from the live catalog: run `DATABASE_URL=... node scripts/gen/test-schema.mjs` and commit the result");
const shape = shapeProblems(ctx);
for (const p of shape) console.error(`production shape: ${p}`);
console.log(`catalog diff: ${diff(step0, last).length} object changes across the migrations, ${chain.unexplained} unexplained class(es), ${drift.length} drifted after the checks, ${keyDiff.length} schema-keys difference(s), ${schemaDiff} test-schema difference(s), ${shape.length} production-shape difference(s)`);
process.exit((props.status ?? 1) || (pins.status ?? 1) || (memdb.status ?? 1) || chain.unexplained || drift.length || keyDiff.length || schemaDiff || shape.length ? 1 : 0);
