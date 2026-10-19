// The `_data_` migrations (cutover-window data changes) are never committed by the schema job. Each is run once after the chain, after the fixture its `-- rollback-test:` header names, inside a transaction that rolls
// back, so its SQL is proven to execute and the catalog is unchanged. A data file that has an `assert` in the apply notes is also run through that file in the same transaction: assertions about the FIXTURE's rows
// (the mapping a split produced, the row a retier must not touch) that the data file's own self-check, which has to hold on production's unknown rows, cannot make.
// The 0016 source backfill is generated at the cutover window from a live registry export: the generator's own output for a sample export is proven every run the same way.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { applyNotes, isData, migrationFiles, MIGRATIONS_DIR } from "../../lib/migrations.mjs";

import { diff, selfCheckProblem, snapshot } from "./chain.mjs";

const NL = "\n";
const noticesOf = (text) => text.split(NL).filter((l) => /NOTICE/.test(l)).map((l) => l.replace(/^.*NOTICE:\s*/, ""));
const errorsIn = (text) => text.split(NL).filter((l) => /ERROR|FATAL/.test(l));

/** The SQL of one rollback test: BEGIN, the fixture, the file without its own framing (the job owns the transaction), the assertions about the fixture, ROLLBACK. */
export function rollbackSql({ fixture, body, assertions = "" }) {
  return ["BEGIN;", fixture, body.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, ""), assertions, "ROLLBACK;", ""].join(NL);
}

/** Run one data file's rollback test. Returns the problems (empty when it passed). */
export function rollbackTest(ctx, name, text, { assertFile = null, before, log }) {
  const fixture = text.match(/^-- rollback-test: (\S+)$/m)?.[1];
  if (!fixture) return [`${name}: a _data_ migration needs a "-- rollback-test: <fixture>" header`];
  if (assertFile && !existsSync(assertFile)) return [`${name}: the apply notes name the assertions ${assertFile}, which does not exist`];
  const r = ctx.psql({ sql: rollbackSql({ fixture: readFileSync(fixture, "utf8"), body: text, assertions: assertFile ? readFileSync(assertFile, "utf8") : "" }) });
  const notices = noticesOf(r.err);
  for (const n of notices) log(`  self-check: ${n.slice(0, 220)}`);
  if (r.code !== 0 || errorsIn(r.err).length) return [`${name}: failed in its rollback-test\n${r.err}`];
  const drifted = diff(before, snapshot(ctx));
  log(`${name}: ran after ${fixture}${assertFile ? ` and ${assertFile}` : ""} and rolled back${drifted.length ? ` UNEXPLAINED catalog change [${drifted.slice(0, 3)}]` : ""}`);
  return [...(drifted.length ? [`${name}: the rollback test changed the catalog (${drifted.length} line(s))`] : []), ...[selfCheckProblem(name, text, notices, applyNotes())].filter(Boolean)];
}

/** Every data file in order, then the generated 0016 sample. Returns the problems. */
export function runDataFiles(ctx, { before, log = console.log, dir = MIGRATIONS_DIR, hooks = null }) {
  const notes = applyNotes(dir);
  const problems = [];
  for (const file of migrationFiles(dir).filter(isData)) {
    const text = readFileSync(`${dir}/${file}`, "utf8").replace(/\r\n/g, NL);
    hooks?.data(file, text);
    problems.push(...rollbackTest(ctx, file, text, { assertFile: notes[file.replace(/\.sql$/, "")]?.assert ?? null, before, log }));
  }
  const gen = spawnSync(process.execPath, ["--import", "./tests/_support/register.mjs", "scripts/gen/source-backfill-sql.mjs", "scripts/ci/fixtures/sources-export-sample.json", "the sample export"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (gen.status !== 0 || !gen.stdout) return [...problems, `source-backfill generator failed\n${gen.stderr}`];
  problems.push(...rollbackTest(ctx, "generated source backfill (sample export)", gen.stdout, { before, log }));
  return problems;
}
