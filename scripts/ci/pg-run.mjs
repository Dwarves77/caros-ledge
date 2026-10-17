// The one database client of the CI scripts (child process of scripts/ci/psql.mjs): runs SQL through `pg`, statement by statement as psql did,
// so the same code runs in CI and on a workstation with no psql. Input on stdin as JSON {url, file?, sql?, tuples?, sep?, stopOnError?}.
// Output: rows to stdout (tuples-only, unaligned, `sep`-separated, null as empty); notices and `psql:<file>:<line>: ERROR:  <message>` lines to stderr.
import { readFileSync } from "node:fs";

import pg from "pg";

import { splitStatements } from "./sql-split.mjs";

const job = JSON.parse(readFileSync(0, "utf8"));
const text = job.file ? readFileSync(job.file, "utf8") : job.sql;
const where = job.file ?? "<stdin>";
const client = new pg.Client({ connectionString: job.url });
client.on("notice", (n) => process.stderr.write(`NOTICE:  ${n.message}\n`));
const raw = { getTypeParser: () => (v) => v };
let code = 0;
try {
  await client.connect();
  for (const { sql, line } of splitStatements(text)) {
    try {
      const r = await client.query({ text: sql, rowMode: "array", types: raw });
      if (job.tuples && r.fields?.length) for (const row of r.rows) process.stdout.write(`${row.map((v) => v ?? "").join(job.sep ?? "|")}\n`);
    } catch (e) {
      process.stderr.write(`psql:${where}:${line}: ERROR:  ${e.message}\n`);
      if (job.stopOnError !== false) { code = 3; break; }
    }
  }
} catch (e) {
  process.stderr.write(`psql: FATAL:  ${e.message}\n`);
  code = 2;
} finally {
  await client.end().catch(() => {});
}
process.exit(code);
