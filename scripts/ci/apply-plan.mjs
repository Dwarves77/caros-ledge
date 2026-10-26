// The cutover apply plan (P2-15, APPLY-1): DERIVED from supabase/migrations on every run, never committed (a committed copy conflicted in every pair of open migration PRs). Every migration file on main, in the order the window applies them:
//   phase 1  the schema files in name order (a file marked "hold" in apply-notes.json waits for the step it names, then runs in its place),
//   phase 2  the data files (`_data_`) in name order, each after the schema it names and with its consumer.
// For each file: its class, the exact CLI command, the self-check it ends with (the id its `RAISE NOTICE '<id> OK'` prints, read from the file), how it is undone (the down file the schema job applies and catalog-compares, or the
// recovery an irreversible file names). What production carries is not in this file: it is public.migration_log (migration 0078), which scripts/ci/migrate.mjs reads.
// `node scripts/ci/apply-plan.mjs` prints the plan and what each file changes (the schema job uploads it as the apply-plan artifact); `--check [--base <git ref>]` derives in memory and exits 1 with one line per problem (planCheck), reading neither
// README.md nor any generated file; scripts/ci/migration-checks.mjs runs the same check before every schema job and in the gates.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { isMain, posix } from "../lib/fs.mjs";
import { MIGRATION_FILE, README_FROZEN_THROUGH, RESERVED_FILE, applyNotes, changeOf, filesAtBase, isData, migrationFiles, numberOf, read, readmeRows, selfCheckIdOf } from "../lib/migrations.mjs";

const DIR = "supabase/migrations";
const CLI = (file) => `supabase db query --linked -f ${DIR}/${file}`;
const cell = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** The self-check id a file prints on success, or "none" when it names none. */
export function selfCheckOf(text, file = "0000_x.sql") {
  return /RAISE NOTICE '([\w.-]+) OK/.test(text) || /^-- Self-check /m.test(text) ? selfCheckIdOf(text, file) : "none";
}

/** How a file is undone: its down file, the recovery it names (`-- irreversible:` line or the apply note), or "none". */
export function rollbackOf(file, text, notes, dir = DIR) {
  if (existsSync(`${dir}/down/${numberOf(file)}.sql`)) return `down/${numberOf(file)}.sql, applied and catalog-compared by the schema job`;
  const recovery = /^-- irreversible: (\S.*)$/m.exec(text)?.[1] ?? notes[file.replace(/\.sql$/, "")]?.irreversible;
  return recovery ? `irreversible: ${recovery}` : "none";
}

export function planProblems(dir = DIR) {
  const files = migrationFiles(dir);
  const notes = applyNotes(dir);
  const problems = [];
  for (const k of Object.keys(notes)) if (!files.includes(`${k}.sql`)) problems.push(`${dir}/apply-notes.json names ${k}, which is not a file`);
  for (const f of files.filter(isData)) {
    const n = notes[f.replace(/\.sql$/, "")];
    if (!n?.consumer || !n?.after) problems.push(`${dir}/apply-notes.json: the data file ${f} needs a "consumer" and an "after"`);
  }
  for (const [k, n] of Object.entries(notes)) {
    if (n.hold !== undefined && !n.hold.trim()) problems.push(`${dir}/apply-notes.json: ${k} has an empty hold`);
    else if (n.hold && !/`[^`]+`|\bstep\b/i.test(n.hold)) problems.push(`${dir}/apply-notes.json: the hold on ${k} names no step (a command in backticks, or "step N")`);
  }
  return problems;
}

/** The number ledger (RESERVED.json): well formed, no number claimed twice, every file above README_FROZEN_THROUGH reserved to a slice, a landed number has its file and a released one has none. */
export function ledgerProblems(dir = DIR, files = migrationFiles(dir)) {
  const path = `${dir}/${RESERVED_FILE}`;
  let rows;
  try {
    rows = JSON.parse(readFileSync(path, "utf8")).reservations;
  } catch (e) {
    return [`${path} cannot be read: ${e.message}`];
  }
  if (!Array.isArray(rows)) return [`${path} has no "reservations" list`];
  const by = new Map();
  const problems = [];
  for (const r of rows) {
    if (!/^\d{4}$/.test(r?.number) || !r.slice || !["reserved", "landed", "released"].includes(r.status) || !/^\d{4}-\d{2}-\d{2}$/.test(r.reserved_on)) problems.push(`${path}: malformed entry ${JSON.stringify(r)} (number, slice, status reserved|landed|released, reserved_on)`);
    else if (by.has(r.number)) problems.push(`${path}: number ${r.number} is reserved to ${by.get(r.number).slice} and to ${r.slice}`);
    else by.set(r.number, r);
  }
  const has = (n) => files.some((f) => numberOf(f) === n);
  for (const [n, r] of by) {
    if (r.status === "landed" && !has(n)) problems.push(`${path}: ${n} (${r.slice}) is marked landed and no file carries it`);
    if (r.status === "released" && has(n)) problems.push(`${path}: ${n} (${r.slice}) is released and a file carries it`);
  }
  for (const f of files) if (numberOf(f) > README_FROZEN_THROUGH && !by.has(numberOf(f))) problems.push(`${dir}/${f}: number ${numberOf(f)} is not reserved to a slice in ${path}`);
  return problems;
}

/** What the files say against git ref `base`: a file added since it must take a number above every file there (merge the base first when main moved on), and a file there must still exist under its name. */
export function baseProblems(dir, base, cwd = ".") {
  const at = filesAtBase(posix(relative(resolve(cwd), resolve(cwd, dir))), base, cwd);
  if (!at) return [`cannot read ${dir} at ${base}: fetch it, or run with MIGRATION_BASE=none`];
  const now = migrationFiles(dir);
  const top = at.length ? numberOf(at.at(-1)) : "0000";
  return [
    ...at.filter((f) => !now.includes(f)).map((f) => `${dir}/${f} is on ${base} and is gone or renamed here: a landed migration keeps its name (if main moved on, merge ${base} first)`),
    ...now.filter((f) => !at.includes(f) && numberOf(f) <= top).map((f) => `${dir}/${f} is out of order: ${top} is already on ${base}; a new migration takes a number above every file there (see ${RESERVED_FILE})`),
  ];
}

/** Every problem of the directory, derived in memory (no committed plan, no README): duplicate numbers, entries that are not migration files, the apply-notes rules, the ledger, and with `base` the order against it. */
export function planCheck(dir = DIR, { base = null, cwd = "." } = {}) {
  const files = migrationFiles(dir);
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !MIGRATION_FILE.test(e.name) && !(e.isDirectory() ? e.name === "down" : ["README.md", "apply-notes.json", RESERVED_FILE].includes(e.name)));
  return [
    ...planProblems(dir),
    ...files.filter((f, i) => i && numberOf(f) === numberOf(files[i - 1])).map((f) => `${dir}/${f} shares the number ${numberOf(f)} with ${files.find((g) => numberOf(g) === numberOf(f))}`),
    ...entries.map((e) => `${dir}/${e.name} is not a migration file, README.md, apply-notes.json, ${RESERVED_FILE} or down/ (a generated plan is never committed)`),
    ...ledgerProblems(dir, files),
    ...(base ? baseProblems(dir, base, cwd) : []),
  ];
}

/** What each file changes: the frozen README table for the files up to README_FROZEN_THROUGH, the file's own `-- change:` line above it. */
export function changesText(dir = DIR) {
  const legacy = readmeRows(dir);
  const row = (f) => `| ${f.replace(/\.sql$/, "")} | ${cell((numberOf(f) <= README_FROZEN_THROUGH ? legacy.get(f.replace(/\.sql$/, "")) : changeOf(read(f, dir))) ?? "none")} |`;
  return ["## What each file changes", "", `Up to ${README_FROZEN_THROUGH} from the frozen table of supabase/migrations/README.md; above it from each file's own \`-- change:\` line.`, "", "| file | change |", "|---|---|", ...migrationFiles(dir).map(row), ""].join("\n");
}

/** The order the window applies the files in: the schema files in name order, then the data files in name order. */
export function planOrder(dir = DIR) {
  const files = migrationFiles(dir);
  return { files, schema: files.filter((f) => !isData(f)), data: files.filter(isData) };
}

/** The file names the `migrate` job applies next, in plan order: not in `logged` (the file names public.migration_log holds) and not a HOLD row (a hold waits for the step it names, which a person runs). */
export function pendingFiles(dir = DIR, logged = new Set()) {
  const { schema, data } = planOrder(dir);
  const notes = applyNotes(dir);
  return [...schema, ...data].filter((f) => !logged.has(f) && !notes[f.replace(/\.sql$/, "")]?.hold);
}

export function planText(dir = DIR) {
  const { schema, data } = planOrder(dir);
  const notes = applyNotes(dir);
  const read = (f) => readFileSync(`${dir}/${f}`, "utf8").replace(/\r\n/g, "\n");
  const row = (n, f, extra) => {
    const text = read(f);
    return `| ${n} | ${f.replace(/\.sql$/, "")} | ${isData(f) ? "data" : "schema"} | \`${CLI(f)}\` | ${selfCheckOf(text, f)} | ${cell(rollbackOf(f, text, notes, dir))} | ${cell(extra)} |`;
  };
  const head = "| # | file | class | command | self-check | rollback | when |\n|---|---|---|---|---|---|---|";
  let n = 0;
  const out = [
    "<!-- DERIVED by `node scripts/ci/apply-plan.mjs` from supabase/migrations and apply-notes.json on every run and uploaded by the schema job as the apply-plan artifact. It is not committed: a committed copy conflicted in every pair of migration PRs. -->",
    "# Cutover apply plan",
    "",
    "Every migration file on main, in the order it is applied to production: the class of each file and its order are all this file says. What production carries is `public.migration_log` (migration 0078); no file in git tracks it.",
    "",
    "Production is migrated by the `migrate` job of .github/workflows/ci.yml, never by hand: on every push to main (and a dispatch with only=migrate) it computes the pending files with `node scripts/ci/migrate.mjs --pending` (this plan's order, HOLD rows left out, every file public.migration_log does not hold; with no log table yet, only 0078), applies each with SUPABASE_DB_URL, one file at a time (a file is one transaction: BEGIN, its change, its self-check DO block, COMMIT; a failing self-check raises and nothing of the file stays), requires the file's own `<id> OK` notice (a file that ends without it fails the job), inserts the file's migration_log row in the same transaction just before the COMMIT (a file is recorded if and only if it applied, so a rerun continues from the next file), and stops at the first failure and prints its ERROR line. The job commits nothing. The command in a row is the manual equivalent for a file the job refuses or a HOLD row: from the repo root with the Supabase CLI logged in and linked to the production project (`supabase login`, `supabase link --project-ref <ref>`), or with `--db-url \"$DATABASE_URL\"` in place of `--linked`.",
    "",
    "Before a run, rehearse the remaining chain on production's real schema and data: `DATABASE_URL=<direct connection> node scripts/cutover/dry-run.mjs` runs the rows from 0004 (HOLD rows left out, then the data files) as one transaction and ends in ROLLBACK; it names the first file that fails and keeps nothing. There is no commit mode: the real apply stays file by file, below.",
    "",
    "Rules: schema first, in name order; a row marked HOLD waits for the step it names; data files after the schema they name (standing rule 3, the two-track policy); stop at the first failure and report it, never skip a file or reorder.",
    "",
    "## Phase 1: schema files, in name order",
    "",
    head,
    ...schema.map((f) => {
      const note = notes[f.replace(/\.sql$/, "")];
      n += 1;
      return row(n, f, note?.hold ? `HOLD: ${note.hold}` : note?.note ? `in order; ${note.note}` : "in order");
    }),
    "",
    "## Phase 2: data files, after the schema (each runs with its consumer)",
    "",
    head,
    ...data.map((f) => {
      const note = notes[f.replace(/\.sql$/, "")];
      n += 1;
      return row(n, f, `consumer: ${note.consumer}; after: ${note.after}`);
    }),
    "",
    "## The 0016 source backfill",
    "",
    "0016 depends on the live registry, so it is generated from a read-only export and committed (it is in phase 2): `node scripts/cutover/export-table.mjs sources --select id,name,url,source_role,source_type --out cutover-run/sources-export.json`, then `node --import ./tests/_support/register.mjs scripts/gen/source-backfill-sql.mjs cutover-run/sources-export.json \"live registry export\" > supabase/migrations/0016_data_source_type_backfill.sql`. The schema job proves the generator on the sample export every run.",
    "",
  ];
  return out.join("\n");
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const bad = planCheck(DIR, { base: args.includes("--base") ? args[args.indexOf("--base") + 1] : null });
  for (const p of bad) console.error(p);
  if (bad.length) process.exit(1);
  if (args.includes("--check")) console.log("apply-plan: clean");
  else process.stdout.write(`${planText()}\n${changesText()}`);
}
