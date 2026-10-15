// Property checks against the applied database (DATABASE_URL), read through psql.
// Checks named in baseline-waivers.json print their offenders and pass; the rest fail the run.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const waivers = JSON.parse(readFileSync("scripts/ci/baseline-waivers.json", "utf8"));

const CHECKS = [
  ["rls-enabled", "RLS enabled on every table in public",
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity ORDER BY 1`],
  ["anon-no-write-policy", "no policy grants INSERT, UPDATE or DELETE to anon",
    `SELECT tablename || '.' || policyname FROM pg_policies
     WHERE schemaname = 'public' AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       AND (roles && ARRAY['anon','public']::name[]) ORDER BY 1`],
  ["fk-indexed", "every foreign key's leading column has a non-partial index",
    `SELECT c.conrelid::regclass || ' (' || c.conname || ')' FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT EXISTS (
       SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NULL) ORDER BY 1`],
  ["definer-search-path", "every SECURITY DEFINER function has search_path pinned",
    `SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) s WHERE s LIKE 'search_path=%') ORDER BY 1`],
  ["function-search-path", "every function in public has search_path pinned",
    `SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) s WHERE s LIKE 'search_path=%') ORDER BY 1`],
];

let failed = false;
for (const [key, label, sql] of CHECKS) {
  const r = spawnSync("psql", [url, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`${key}: query failed\n${r.stderr}`);
    process.exit(1);
  }
  const rows = r.stdout.split("\n").filter(Boolean);
  const waiver = waivers[key];
  if (rows.length === 0) {
    console.log(`PASS ${key}: ${label}`);
    continue;
  }
  const heading = waiver ? "KNOWN BASELINE FAILURES, forward migrations owed" : "FAIL";
  console.log(`${heading} ${key}: ${label} (${rows.length} offending${waiver ? `, baseline ${waiver.baseline}, owner ${waiver.owner}, since ${waiver.date}` : ""})`);
  for (const row of rows) console.log(`  ${row}`);
  if (waiver && rows.length > waiver.baseline) {
    console.error(`${key}: ${rows.length} offenders exceed the waived baseline ${waiver.baseline}`);
    failed = true;
  } else if (!waiver) failed = true;
}
process.exit(failed ? 1 : 0);
