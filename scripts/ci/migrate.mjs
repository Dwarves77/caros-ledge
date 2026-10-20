// The `migrate` job's script: production is migrated by the repository, not by a person. The pending files are the plan's (scripts/ci/apply-plan.mjs: name order, schema before data, HOLD rows left out) that APPLIED.json does not list.
//   node scripts/ci/migrate.mjs --pending   prints the pending file names, one per line
//   node scripts/ci/migrate.mjs --apply     applies them in order to SUPABASE_DB_URL, one file at a time (scripts/ci/pg-run.mjs, stop on the first error)
// A file counts as applied only when its run exits 0, prints no ERROR line AND prints its own `<id> OK` notice: a file whose self-check printed nothing did not check anything. The first failure stops the run and prints its ERROR line;
// the job summary lists each file with OK or its error. When every pending file passed and at least one was applied, `applied.txt` (every applied file name, the previous list included) is written for scripts/cutover/write-applied.mjs
// and `applied=<numbers>` goes to $GITHUB_OUTPUT, which the workflow's commit step reads. A missing SUPABASE_DB_URL follows the one exit-code contract (src/core/harness/exit.ts): exit 1 naming the secret where the event can carry it.
import { appendFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";
import { appliedNumbers, migrationFiles, numberOf, read, selfCheckIdOf } from "../lib/migrations.mjs";

import { pendingFiles } from "./apply-plan.mjs";
import { psql } from "./psql.mjs";

const NL = "\n";

/** Why a file's run does not count as applied, or null: a failed exit or an ERROR line (the first is returned), else a self-check that did not print its own OK notice. */
export function runProblem(file, text, { status, stderr }) {
  const errors = stderr.split(NL).filter((l) => /ERROR|FATAL/.test(l));
  if (errors.length) return errors[0].trim();
  if (status !== 0) return `${file}: exited ${status} without an ERROR line`;
  const id = selfCheckIdOf(text, file);
  const printed = stderr.split(NL).some((l) => /NOTICE/.test(l) && l.replace(/^.*NOTICE:\s*/, "").startsWith(`${id} OK`));
  return printed ? null : `${file}: its self-check ${id} did not print "${id} OK" (it ran nothing, or stopped before its last assertion)`;
}

/** Apply `files` in order with `run(file)` -> { status, stderr }; stop at the first one that does not count as applied. Returns { results: [{ file, problem }], applied }. */
export function applyAll(files, run, dir = "supabase/migrations") {
  const results = [];
  for (const file of files) {
    const problem = runProblem(file, read(file, dir), run(file));
    results.push({ file, problem });
    if (problem) break;
  }
  return { results, applied: results.filter((r) => !r.problem).map((r) => r.file) };
}

/** Every file name whose number production carries after this run: the numbers APPLIED.json lists plus the files just applied. */
export function appliedAfter(applied, dir = "supabase/migrations") {
  const numbers = new Set([...appliedNumbers(dir), ...applied.map(numberOf)]);
  return migrationFiles(dir).filter((f) => numbers.has(numberOf(f)));
}

async function main() {
  const { values } = parseArgs({ options: { pending: { type: "boolean", default: false }, apply: { type: "boolean", default: false } }, strict: true });
  if (values.pending) {
    for (const f of pendingFiles()) console.log(f);
    return 0;
  }
  if (!values.apply) {
    console.error("usage: node scripts/ci/migrate.mjs --pending | --apply");
    return 1;
  }
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { skipVerdict, summarise } = await import("../../src/core/harness/exit.ts");
  const env = process.env;
  const url = env.SUPABASE_DB_URL;
  const verdict = skipVerdict(env, url ? [] : ["SUPABASE_DB_URL"], true);
  if (verdict.message) {
    console.error(`migrate: ${verdict.message}`);
    summarise(env, "Migrate", verdict);
    return verdict.exit;
  }
  const summary = (lines) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `### Migrate\n\n${lines.join(NL)}\n`);
  const pending = pendingFiles();
  if (!pending.length) {
    console.log("migrate: no pending migration; nothing to apply");
    summary(["No pending migration; nothing to apply."]);
    return 0;
  }
  console.log(`migrate: pending ${pending.join(", ")}`);
  const { results, applied } = applyAll(pending, (file) => {
    const r = psql(url, { file: `supabase/migrations/${file}`, stopOnError: true });
    return { status: r.status, stderr: r.stderr };
  });
  summary(results.map((r) => `- ${r.file}: ${r.problem ?? "OK"}`));
  for (const r of results) console.log(`${r.problem ? "FAILED" : "OK    "} ${r.file}${r.problem ? `\n${r.problem}` : ""}`);
  if (applied.length < pending.length) return 1;
  writeFileSync("applied.txt", `${appliedAfter(applied).join(NL)}${NL}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `applied=${applied.map(numberOf).join(" ")}${NL}`);
  console.log(`migrate: applied ${applied.length} file(s): ${applied.map(numberOf).join(" ")}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await main());
