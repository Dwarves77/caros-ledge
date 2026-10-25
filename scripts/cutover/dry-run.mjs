// Cutover dry run: the remaining migration files, in apply order, as ONE transaction on the database DATABASE_URL names (the direct connection), ending in ROLLBACK.
// It proves the chain on production's real schema and data before the window resumes; nothing is kept. There is no --commit: the real apply stays file-by-file through the runner in supabase/migrations/APPLY.md.
//   DATABASE_URL=<direct url> node scripts/cutover/dry-run.mjs [--from 0004] [file ...]
// With no file names the list is the apply plan's (scripts/ci/apply-plan.mjs): the schema files from --from (default 0004) in name order minus the rows apply-notes.json holds, then the data files in name order. Names may be given with or without .sql.
// Each file's own first `BEGIN;` and last `COMMIT;` are stripped (a file framed any other way is refused), and `cutover-dry-run: <file>` is raised between files so the first failure names its file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const DIR = "supabase/migrations";
const isData = (f) => f.includes("_data_");
const code = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));

/** The file's text between its own leading BEGIN; and trailing COMMIT;, or throws when it is not framed exactly so. Pure. */
export function stripFraming(name, text) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith("--"));
  let last = lines.length - 1;
  while (last >= 0 && (!lines[last].trim() || lines[last].trim().startsWith("--"))) last -= 1;
  if (first < 0 || lines[first].trim() !== "BEGIN;" || lines[last].trim() !== "COMMIT;") throw new Error(`${name}: not framed BEGIN; ... COMMIT; (first and last statement)`);
  const body = lines.slice(first + 1, last);
  if (code(body.join("\n")).some((l) => /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION);$/i.test(l))) throw new Error(`${name}: a transaction statement inside the body would end the dry run's transaction`);
  return body.join("\n");
}

// The real apply runs each file in its own transaction, so SET LOCAL settings die at the file boundary; here they would outlive it. These two are replicated after every body (not RESET ALL: a file may set a session setting for its successors).
const RESET = "RESET ROLE; RESET session_replication_role;";

/** The single script for [{name, text}] in order: BEGIN; marker, body per file; ROLLBACK;. Pure. */
export function buildScript(files) {
  if (!files.length) throw new Error("dry-run: no files");
  const parts = ["BEGIN;"];
  for (const { name, text } of files) {
    parts.push(`DO $dry$ BEGIN RAISE NOTICE 'cutover-dry-run: ${name}'; END $dry$;`, stripFraming(name, text), RESET);
  }
  parts.push("ROLLBACK;");
  return parts.join("\n");
}

/** The ordered file names the apply plan lists from `from`: schema files minus HOLD rows, then data files. Pure given the directory listing and notes. */
export function planFiles(names, notes, from = "0004") {
  const all = names.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const held = (f) => Boolean(notes[f.replace(/\.sql$/, "")]?.hold);
  return [...all.filter((f) => !isData(f) && f.slice(0, 4) >= from && !held(f)), ...all.filter((f) => isData(f) && f.slice(0, 4) >= from)];
}

async function run() {
  const args = process.argv.slice(2);
  const fi = args.indexOf("--from");
  const from = fi >= 0 ? args.splice(fi, 2)[1] : "0004";
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { skipVerdict } = await import("../../src/core/harness/exit.ts");
  const url = process.env.DATABASE_URL;
  const verdict = skipVerdict(process.env, url ? [] : ["DATABASE_URL"], true); // a rehearsal asked for by name that has no database has not run
  if (verdict.message) { console.error(`dry run: ${verdict.message} (the direct connection string)`); process.exit(verdict.exit); }
  const notes = existsSync(`${DIR}/apply-notes.json`) ? JSON.parse(readFileSync(`${DIR}/apply-notes.json`, "utf8")) : {};
  const names = args.length ? args.map((a) => (a.endsWith(".sql") ? a : `${a}.sql`)) : planFiles(readdirSync(DIR), notes, from);
  let script;
  try {
    script = buildScript(names.map((name) => ({ name, text: readFileSync(`${DIR}/${name}`, "utf8") })));
  } catch (e) { console.error(e.message); process.exit(1); }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  let current = "(before the first file)";
  client.on("notice", (n) => {
    const m = /^cutover-dry-run: (.*)$/.exec(n.message);
    if (m) { current = m[1]; console.log(`step ${m[1]}`); } else console.log(`  ${n.message}`);
  });
  let status = 0;
  try {
    await client.connect();
    await client.query(script);
    console.log(`dry run: ${names.length} file(s) reached ROLLBACK; nothing was kept`);
  } catch (e) {
    console.error(`dry run FAILED in ${current}: ${e.message}${e.where ? `\n  where: ${e.where}` : ""}`);
    await client.query("ROLLBACK").catch(() => {});
    status = 1;
  } finally { await client.end().catch(() => {}); }
  process.exit(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
