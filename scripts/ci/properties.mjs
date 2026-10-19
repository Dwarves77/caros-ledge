// Property checks against the applied database (DATABASE_URL), read through the pg client (scripts/ci/psql.mjs).
// Each check is scripts/ci/checks/<key>.sql (first line: its label); `{{schemas}}` in it is the array of the schemas the app reads (every schema that is not the platform's, see judge.mjs). The verdicts are in
// scripts/ci/properties/judge.mjs: a check fails on any offender no waiver names (scripts/ci/baseline-waivers.json names each waived row and the slice that owes the fix), and every check is proven on every run by an
// attack: its planted violation (scripts/ci/fixtures/<key>.sql, whose `-- expect:` lines say what each branch returns) is run inside a transaction that rolls back, and the check must report exactly those rows.
//   node scripts/ci/properties.mjs [--only <key>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { appSchemasSql, attackProblems, judgeRows, waiverShapeProblems } from "./properties/judge.mjs";
import { psql } from "./psql.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const { values } = parseArgs({ options: { only: { type: "string" } }, strict: true });
const keys = readdirSync("scripts/ci/checks").filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)).sort();
if (values.only && !keys.includes(values.only)) {
  console.error(`--only ${values.only}: there is no such check (${keys.join(", ")})`);
  process.exit(1);
}

function rowsOf(sql) {
  const r = psql(url, { sql, tuples: true });
  if (r.status !== 0) {
    console.error(`query failed\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.split("\n").filter(Boolean);
}

const platform = JSON.parse(readFileSync("scripts/ci/data/production-shape.json", "utf8")).shape.schemaAcls.map((s) => s.schema);
const schemaSql = appSchemasSql(platform);
const schemas = rowsOf(`SELECT unnest(${schemaSql})`);
const withSchemas = (sql) => sql.replaceAll("{{schemas}}", schemaSql);

const waivers = JSON.parse(readFileSync("scripts/ci/baseline-waivers.json", "utf8"));
const problems = waiverShapeProblems(waivers, keys);
let nChecks = 0;
let nPlanted = 0;
for (const key of values.only ? [values.only] : keys) {
  const sql = withSchemas(readFileSync(`scripts/ci/checks/${key}.sql`, "utf8"));
  const label = sql.split("\n")[0].replace(/^-- /, "");
  const rows = rowsOf(sql);
  const verdict = judgeRows(key, rows, waivers[key]);
  nChecks += 1;
  console.log(`${verdict.status} ${key}: ${label}${verdict.waived.length ? ` (${verdict.waived.length} waived, slice ${waivers[key].slice})` : ""}`);
  for (const row of rows) console.log(`  ${row}`);
  problems.push(...verdict.problems);
  const fixture = `scripts/ci/fixtures/${key}.sql`;
  const fixtureText = existsSync(fixture) ? readFileSync(fixture, "utf8") : null;
  const planted = fixtureText === null ? [] : rowsOf(`BEGIN;\n${withSchemas(fixtureText)}\n${sql}\nROLLBACK;`);
  const attack = attackProblems(key, fixtureText, planted, rows);
  problems.push(...attack);
  nPlanted += planted.filter((r) => !rows.includes(r)).length;
}
for (const p of problems) console.error(p);
console.log(`${nChecks} checks over ${schemas.join(", ")}, ${nPlanted} planted violations flagged`);
process.exit(problems.length ? 1 : 0);
