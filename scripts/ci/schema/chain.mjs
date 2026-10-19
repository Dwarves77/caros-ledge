// The migration chain of the schema job: every supabase/migrations/NNNN_*.sql in name order on the database `base.mjs` built, one catalog snapshot per step. For each file:
//   - it applies with no error and prints its own `<id> OK` notice (the id on its `-- Self-check` line): a file whose self-check did not run, or ran and printed nothing, fails;
//   - the classes of catalog object it changed (snapshot diff) equal the classes its `-- catalog:` header declares (plus any the apply notes grant an applied file whose header predates a class);
//   - if it has a down file (supabase/migrations/down/NNNN.sql), the down file, applied in a transaction that rolls back, returns the catalog to the snapshot taken before the file.
// A `_data_` file is not part of the chain (it is run once at the cutover window): scripts/ci/schema/data.mjs proves it after the chain.
import { existsSync, readFileSync } from "node:fs";

import { applyNotes, declaredClasses, isData, migrationFiles, MIGRATIONS_DIR, numberOf, selfCheckIdOf } from "../../lib/migrations.mjs";

const NL = "\n";
export const SNAPSHOT_SQL = readFileSync("scripts/ci/catalog-snapshot.sql", "utf8");
export const downPath = (file) => `${MIGRATIONS_DIR}/down/${numberOf(file)}.sql`;

/** The catalog now, as sorted `class|object|detail` lines. */
export function snapshot({ psql }) {
  const r = psql({ sql: SNAPSHOT_SQL, tuples: true, sep: "|" });
  if (r.code !== 0) throw new Error(`the catalog snapshot failed: ${r.err}`);
  return r.out.split(NL).filter(Boolean);
}

/** Lines in exactly one of the two snapshots. */
export function diff(a, b) {
  const [sa, sb] = [new Set(a), new Set(b)];
  return [...b.filter((l) => !sa.has(l)), ...a.filter((l) => !sb.has(l))];
}

export const classOf = (line) => line.split("|")[0];
const noticesOf = (text) => text.split(NL).filter((l) => /NOTICE/.test(l)).map((l) => l.replace(/^.*NOTICE:\s*/, ""));
const errorsIn = (text) => text.split(NL).filter((l) => /ERROR|FATAL/.test(l));

/** Does a file's output carry `<id> OK`? An id the apply notes say a later file carries instead (an applied file whose self-check was missing) is not required of this one. */
export function selfCheckProblem(file, text, notices, notes) {
  if (notes[file.replace(/\.sql$/, "")]?.selfCheckBy) return null;
  const id = selfCheckIdOf(text, file);
  return notices.some((n) => n === `${id} OK` || n.startsWith(`${id} OK`)) ? null : `${file}: its self-check ${id} did not print "${id} OK" (it ran nothing, or stopped before its last assertion)`;
}

/**
 * Apply every non-data file in order. `hooks.before(file, text, state)` runs before the real apply (the self-check mutants use it); `log` receives the progress lines.
 * Returns { problems, unexplained, last, steps } where `steps` maps a file to the snapshot after it.
 */
export function runChain(ctx, { dir = MIGRATIONS_DIR, log = console.log, hooks = {} } = {}) {
  const notes = applyNotes(dir);
  const problems = [];
  let unexplained = 0;
  let before = snapshot(ctx);
  const first = before;
  for (const file of migrationFiles(dir).filter((f) => !isData(f))) {
    const path = `${dir}/${file}`;
    const text = readFileSync(path, "utf8").replace(/\r\n/g, NL);
    hooks.before?.(file, text, { before });
    const m = ctx.psql({ file: path });
    const notices = noticesOf(m.err);
    for (const n of notices) log(`  self-check: ${n}`);
    if (m.code !== 0 || errorsIn(m.err).length) {
      problems.push(`${file}: failed\n${m.err}`);
      return { problems, unexplained, steps: new Map(), first };
    }
    const missing = selfCheckProblem(file, text, notices, notes);
    if (missing) problems.push(missing);
    const after = snapshot(ctx);
    const changed = new Set(diff(before, after).map(classOf));
    const declared = new Set([...declaredClasses(text), ...(notes[file.replace(/\.sql$/, "")]?.catalogExtra ?? [])]);
    const off = [...changed].filter((c) => !declared.has(c)).concat([...declared].filter((c) => !changed.has(c)).map((c) => `declared but unchanged: ${c}`));
    log(`${file}: changed [${[...changed].sort()}]${off.length ? ` UNEXPLAINED [${off}]` : ""}`);
    unexplained += off.length;
    if (off.length) {
      // The differing snapshot lines of an unexplained step (class|object|detail), removed then added, so a red run names the objects and not only the classes.
      const [sb, sa] = [new Set(before), new Set(after)];
      const lines = [...before.filter((l) => !sa.has(l)).map((l) => `  - ${l}`), ...after.filter((l) => !sb.has(l)).map((l) => `  + ${l}`)];
      for (const l of lines.slice(0, 40)) log(l.slice(0, 300));
      if (lines.length > 40) log(`  ... ${lines.length - 40} more differing line(s)`);
    }
    problems.push(...downProblems(ctx, file, before));
    before = after;
  }
  return { problems, unexplained, last: before, first };
}

/** The down file of a schema file: applied in a transaction that is rolled back, the catalog must equal the snapshot taken before the file. A file with none must say why it is irreversible; migration-checks.mjs enforces that statically. */
export function downProblems(ctx, file, before) {
  const down = downPath(file);
  if (!existsSync(down)) return [];
  const body = readFileSync(down, "utf8").replace(/\r\n/g, NL);
  const r = ctx.psql({ sql: `BEGIN;${NL}${body}${NL}${SNAPSHOT_SQL}${NL}ROLLBACK;`, tuples: true, sep: "|" });
  if (r.code !== 0 || errorsIn(r.err).length) return [`${down}: failed\n${r.err}`];
  const rows = r.out.split(NL).filter(Boolean);
  const drift = diff(before, rows);
  if (!drift.length) return [];
  return [`${down}: the catalog after the down file differs from the catalog before ${file} (${drift.length} line(s)); first: ${drift.slice(0, 3).map((l) => l.slice(0, 200)).join(" || ")}`];
}
