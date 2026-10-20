// The `migrate` job's script: production is migrated by the repository, not by a person, and the database is the record of what it carries (public.migration_log, migration 0078); no file in git tracks it and CI commits nothing.
//   node scripts/ci/migrate.mjs --pending   prints the pending file names: the plan's order (scripts/ci/apply-plan.mjs: schema before data, HOLD rows left out) minus the files migration_log holds
//   node scripts/ci/migrate.mjs --apply     applies them in order to SUPABASE_DB_URL, one file at a time, and stops at the first failure
// A file is applied statement by statement on one connection. Its own final COMMIT is held back until the file printed its own `<id> OK` notice; then the file's migration_log row (file, the notice as self_check) is inserted in the same
// transaction and the COMMIT follows, so a file is recorded if and only if it applied. A file whose self-check printed nothing, or any statement that fails, is rolled back with no row and stops the run; a rerun continues from the next file.
// With no migration_log table yet the only pending file is the bootstrap, 0078, which creates and seeds the table; once it is applied the log is read again and the normal rule holds. The job summary lists each file with OK or its error.
// A missing SUPABASE_DB_URL follows the one exit-code contract (src/core/harness/exit.ts): exit 1 naming the secret where the event can carry it.
import { appendFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

import pg from "pg";

import { isMain } from "../lib/fs.mjs";
import { read, selfCheckIdOf } from "../lib/migrations.mjs";

import { pendingFiles } from "./apply-plan.mjs";
import { splitStatements } from "./sql-split.mjs";

const NL = "\n";
const DIR = "supabase/migrations";
export const BOOTSTRAP = "0078_migration_log.sql";
const INSERT_LOG = "INSERT INTO public.migration_log (file, self_check) VALUES ($1, $2) ON CONFLICT (file) DO NOTHING";

/** The files still to apply: the plan's order minus the logged ones; with no log table (`logged` null) only the bootstrap file. */
export function pendingFromLog(dir, logged) {
  return logged === null ? pendingFiles(dir).filter((f) => f === BOOTSTRAP) : pendingFiles(dir, logged);
}

/** The file names migration_log holds, or null when the table does not exist yet. */
export async function readLog(client) {
  try {
    const r = await client.query("SELECT file FROM public.migration_log");
    return new Set(r.rows.map((row) => row.file));
  } catch (e) {
    if (e.code === "42P01") return null;
    throw e;
  }
}

/**
 * Apply one file on `client` (a pg client, or anything with query and on("notice")). Returns { problem } with problem null when the file applied and was recorded. The COMMIT is held back until the file's own `<id> OK` notice was
 * printed; the log row goes in just before it, in the same transaction. A file with no COMMIT of its own is wrapped in a BEGIN and a COMMIT here.
 */
export async function applyFile(client, file, text) {
  const notices = [];
  const listener = (n) => notices.push(n.message);
  client.on("notice", listener);
  const statements = splitStatements(text.replace(/\r\n/g, NL)).map((s) => s.sql);
  const commitAt = statements.findLastIndex((s) => /^COMMIT\b/i.test(s));
  const fail = async (problem) => {
    await client.query("ROLLBACK").catch(() => undefined);
    return { problem };
  };
  try {
    if (commitAt < 0) await client.query("BEGIN");
    for (const [i, sql] of statements.entries()) {
      if (i === commitAt) break;
      try {
        await client.query(sql);
      } catch (e) {
        return await fail(`${file}: ERROR:  ${e.message}${e.code ? ` [SQLSTATE ${e.code}]` : ""}`);
      }
    }
    const id = selfCheckIdOf(text, file);
    const ok = notices.find((n) => n.startsWith(`${id} OK`));
    if (!ok) return await fail(`${file}: its self-check ${id} did not print "${id} OK" (it ran nothing, or stopped before its last assertion)`);
    try {
      await client.query(INSERT_LOG, [file, ok]);
      await client.query("COMMIT");
    } catch (e) {
      return await fail(`${file}: ERROR:  ${e.message}${e.code ? ` [SQLSTATE ${e.code}]` : ""}`);
    }
    return { problem: null };
  } finally {
    client.removeListener("notice", listener);
  }
}

/** Apply `files` in order; stop at the first that does not apply. Returns { results: [{ file, problem }], applied }. */
export async function applyAll(client, files, dir = DIR) {
  const results = [];
  for (const file of files) {
    const { problem } = await applyFile(client, file, read(file, dir));
    results.push({ file, problem });
    if (problem) break;
  }
  return { results, applied: results.filter((r) => !r.problem).map((r) => r.file) };
}

async function main() {
  const { values } = parseArgs({ options: { pending: { type: "boolean", default: false }, apply: { type: "boolean", default: false } }, strict: true });
  if (values.pending === values.apply) {
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
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const logged = await readLog(client);
    let pending = pendingFromLog(DIR, logged);
    if (values.pending) {
      for (const f of pending) console.log(f);
      return 0;
    }
    const results = [];
    if (logged === null) {
      const first = await applyAll(client, [BOOTSTRAP]);
      results.push(...first.results);
      if (first.applied.length === 0) return report(results, summary);
      pending = pendingFromLog(DIR, await readLog(client));
    }
    if (!pending.length && !results.length) {
      console.log("migrate: no pending migration; nothing to apply");
      summary(["No pending migration; nothing to apply."]);
      return 0;
    }
    console.log(`migrate: pending ${pending.join(", ") || "(none after the bootstrap)"}`);
    results.push(...(await applyAll(client, pending)).results);
    return report(results, summary);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function report(results, summary) {
  summary(results.map((r) => `- ${r.file}: ${r.problem ?? "OK"}`));
  for (const r of results) console.log(`${r.problem ? "FAILED" : "OK    "} ${r.file}${r.problem ? `${NL}${r.problem}` : ""}`);
  const failed = results.some((r) => r.problem);
  if (!failed) console.log(`migrate: applied ${results.length} file(s)`);
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(await main());
