// Property checks against the applied database (DATABASE_URL), read through the pg client (scripts/ci/psql.mjs).
// Each check is scripts/ci/checks/<key>.sql (first line: its label). A waiver in baseline-waivers.json names the slice that owes
// the fix; a check without a waiver fails the run on any offender. Every check is also proven on every run by an attack: its
// planted violation (scripts/ci/fixtures/<key>.sql) is run inside a transaction that rolls back, and the check must report a row
// it did not report live. A check that passes its planted violation fails the run.
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { psql } from "./psql.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const waivers = JSON.parse(readFileSync("scripts/ci/baseline-waivers.json", "utf8"));
let failed = false;
for (const [key, w] of Object.entries(waivers)) {
  if (!/^P\d-[A-Z0-9]+$/.test(w.slice ?? "") || !w.date || !Number.isInteger(w.baseline)) {
    console.error(`waiver ${key}: needs slice (e.g. P2-S1), date and integer baseline`);
    failed = true;
  }
}

function rowsOf(sql) {
  const r = psql(url, { sql, tuples: true });
  if (r.status !== 0) {
    console.error(`query failed\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.split("\n").filter(Boolean);
}

let nChecks = 0;
let nPlanted = 0;
for (const file of readdirSync("scripts/ci/checks").filter((f) => f.endsWith(".sql")).sort()) {
  const key = file.slice(0, -4);
  const sql = readFileSync(`scripts/ci/checks/${file}`, "utf8");
  const label = sql.split("\n")[0].replace(/^-- /, "");
  const rows = rowsOf(sql);
  const waiver = waivers[key];
  nChecks += 1;
  if (rows.length === 0) console.log(`PASS ${key}: ${label}`);
  else {
    const waived = waiver && rows.length <= waiver.baseline;
    console.log(`${waived ? "WAIVED" : "FAIL"} ${key}: ${label} (${rows.length} offending${waiver ? `, baseline ${waiver.baseline}, slice ${waiver.slice}` : ""})`);
    for (const row of rows) console.log(`  ${row}`);
    if (!waived) failed = true;
  }
  const fixture = `scripts/ci/fixtures/${key}.sql`;
  const hits = existsSync(fixture) ? rowsOf(`BEGIN;\n${readFileSync(fixture, "utf8")}\n${sql}\nROLLBACK;`).filter((r) => !rows.includes(r)) : [];
  if (hits.length === 0) {
    console.error(`ATTACK FAILED ${key}: ${existsSync(fixture) ? "the planted violation passed" : "no planted violation in scripts/ci/fixtures"}`);
    failed = true;
  } else nPlanted += hits.length;
}
console.log(`${nChecks} checks, ${nPlanted} planted violations flagged`);
process.exit(failed ? 1 : 0);
