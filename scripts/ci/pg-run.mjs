// The one database client of the CI scripts (child process of scripts/ci/psql.mjs): runs SQL through `pg`, statement by statement as psql did,
// so the same code runs in CI and on a workstation with no psql. Input on stdin as JSON {url, file?, sql?, tuples?, sep?, stopOnError?}.
// Output: rows to stdout (tuples-only, unaligned, `sep`-separated, null as empty); notices and `psql:<file>:<line>: ERROR:  <message> [SQLSTATE <code>]` lines to stderr (the code lets a caller tell a RAISE EXCEPTION, P0001, from any other failure).
import { readFileSync } from "node:fs";

import pg from "pg";

import { splitStatements } from "./sql-split.mjs";
import { drained } from "./stdout-drain.mjs";

const job = JSON.parse(readFileSync(0, "utf8"));
// Line endings are the file's checkout setting (a Windows checkout has CRLF, which would end up inside every function body the file creates): the database sees LF, as on the CI runner.
const text = (job.file ? readFileSync(job.file, "utf8") : job.sql).replaceAll("\r\n", "\n");
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
      process.stderr.write(`psql:${where}:${line}: ERROR:  ${e.message}${e.code ? ` [SQLSTATE ${e.code}]` : ""}\n`);
      if (job.stopOnError !== false) { code = 3; break; }
    }
  }
} catch (e) {
  process.stderr.write(`psql: FATAL:  ${e.message}\n`);
  code = 2;
} finally {
  await client.end().catch(() => {});
}
await drained(process.stdout); // the result is complete on a pipe before the process ends
process.exitCode = code;
