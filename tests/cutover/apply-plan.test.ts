// APPLY-1: the apply plan is derived, never committed, and a migration PR touches only its own files. Each check is proven by a planted violation in a fixture repository (a clean control first, the plant red, the repair green);
// INV-APPLY-2 is proven by two real branches merging in a temporary git repository, and its attack is the same merge on the layout this slice removed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

// @ts-expect-error plain .mjs modules
import { pendingFromLog } from "../../scripts/ci/migrate.mjs";
// @ts-expect-error plain .mjs modules
import { pendingFiles, planCheck } from "../../scripts/ci/apply-plan.mjs";
// @ts-expect-error plain .mjs modules
import { migrationProblems } from "../../scripts/ci/migration-checks.mjs";
// @ts-expect-error plain .mjs modules
import { defaultBase, README_FROZEN_THROUGH } from "../../scripts/lib/migrations.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const REAL = join(ROOT, "supabase/migrations");
const DIR = "supabase/migrations";
// the fixture base holds the migrations up to the README boundary: a file above it is a slice's own, reserved in the real ledger, and is not part of the fixture's world
const BELOW_BOUNDARY = { recursive: true, filter: (s: string) => !(/^[0-9]{4}[_.]/.test(basename(s)) && basename(s).slice(0, 4) > README_FROZEN_THROUGH) };

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Claude", "-c", "user.email=noreply@anthropic.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (repo: string, rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const entry = (number: string, slice: string, status: string) => ({ number, slice, status, reserved_on: "2026-10-26" });
const migration = (n: string, change: string | null = "planted change") => `${change ? `-- change: ${change}\n` : ""}-- Self-check ${n}-planted\n-- irreversible: nothing is written, nothing to undo\nBEGIN;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'never'; END IF; RAISE NOTICE '${n}-planted OK'; END $$;\nCOMMIT;\n`;
const writeLedger = (repo: string, rows: object[]) => put(repo, `${DIR}/RESERVED.json`, `${JSON.stringify({ about: "fixture", reservations: rows }, null, 2)}\n`);

/** The notes of a file above the boundary describe a file the fixture does not hold (a slice's own migration): the fixture's copy of apply-notes.json drops them. */
function pruneNotes(repo: string) {
  const file = join(repo, DIR, "apply-notes.json");
  const notes = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const k of Object.keys(notes)) if (!existsSync(join(repo, DIR, `${k}.sql`))) delete notes[k];
  writeFileSync(file, `${JSON.stringify(notes, null, 2)}
`);
}

/** A repository whose main holds a copy of the real migrations plus 0138 (landed) with 0135 and 0139 reserved: the base every check below compares with. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "apply-1-"));
  cpSync(REAL, join(repo, DIR), BELOW_BOUNDARY);
  pruneNotes(repo);
  const ledger = JSON.parse(readFileSync(join(REAL, "RESERVED.json"), "utf8")).reservations.filter((r: { number: string }) => r.number <= README_FROZEN_THROUGH);
  writeLedger(repo, [...ledger, entry("0135", "A", "reserved"), entry("0138", "B", "landed"), entry("0139", "C", "reserved"), entry("0140", "D", "reserved")]);
  put(repo, `${DIR}/0138_base_tip.sql`, migration("0138"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, dir: join(repo, DIR), base: git(repo, "rev-parse", "HEAD") };
}
const check = (f: { repo: string; dir: string; base: string }) => (planCheck(f.dir, { base: f.base, cwd: f.repo }) as string[]).join("\n");
const cleanup = (repo: string) => rmSync(repo, { recursive: true, force: true });

test("the committed tree is clean against its own checks, holds no generated plan, and the migrate job selects the same files with or without one", () => {
  assert.ok(!existsSync(join(REAL, "APPLY.md")), "APPLY.md is gone from the tree");
  assert.deepEqual(planCheck(DIR), []);
  assert.deepEqual(migrationProblems(DIR), []);
  const files = readdirSync(REAL).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  assert.deepEqual(pendingFromLog(DIR, new Set(files.slice(0, 3))), pendingFiles(DIR, new Set(files.slice(0, 3))), "migrate reads the directory and the log, never a plan file");
  assert.equal(defaultBase({ MIGRATION_BASE: "none" }), null);
  assert.equal(defaultBase({ MIGRATION_BASE: "origin/dev" }), "origin/dev");
  assert.equal(defaultBase({ GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" }), "origin/main");
  assert.equal(defaultBase({ GITHUB_ACTIONS: "true" }), null, "a push has no base");
});

test("a number below the highest one on the base turns the check red; a number above it, reserved, is green", () => {
  const f = fixture();
  try {
    assert.equal(check(f), "", "control: the base itself is clean");
    put(f.repo, `${DIR}/0135_late.sql`, migration("0135"));
    assert.match(check(f), /0135_late\.sql is out of order: 0138 is already on \S+; a new migration takes a number above every file there/);
    rmSync(join(f.dir, "0135_late.sql"));
    put(f.repo, `${DIR}/0139_ok.sql`, migration("0139"));
    assert.equal(check(f), "", "a reserved number above the base's highest lands");
    assert.deepEqual(migrationProblems(f.dir, { base: f.base, cwd: f.repo }), [], "and it passes the whole static check with its own change line and no README row");
  } finally {
    cleanup(f.repo);
  }
});

test("a number no slice reserved, a number reserved twice and two files with one number each turn the check red", () => {
  const f = fixture();
  try {
    put(f.repo, `${DIR}/0141_unreserved.sql`, migration("0141"));
    assert.match(check(f), /0141_unreserved\.sql: number 0141 is not reserved to a slice in \S+RESERVED\.json/);
    rmSync(join(f.dir, "0141_unreserved.sql"));
    assert.equal(check(f), "");
    const rows = JSON.parse(readFileSync(join(f.dir, "RESERVED.json"), "utf8")).reservations;
    writeLedger(f.repo, [...rows, entry("0139", "E", "reserved")]);
    assert.match(check(f), /number 0139 is reserved to C and to E/);
    writeLedger(f.repo, rows);
    put(f.repo, `${DIR}/0139_a.sql`, migration("0139"));
    put(f.repo, `${DIR}/0139_b.sql`, migration("0139"));
    assert.match(check(f), /0139_b\.sql shares the number 0139 with 0139_a\.sql/);
    rmSync(join(f.dir, "0139_b.sql"));
    assert.equal(check(f), "");
    writeLedger(f.repo, rows.map((r: { number: string }) => (r.number === "0138" ? { ...r, status: "released" } : r)));
    assert.match(check(f), /0138 \(B\) is released and a file carries it/);
    writeLedger(f.repo, rows.map((r: { number: string }) => (r.number === "0140" ? { ...r, status: "landed" } : r)));
    assert.match(check(f), /0140 \(D\) is marked landed and no file carries it/);
  } finally {
    cleanup(f.repo);
  }
});

test("a file removed or renamed since the base, a file that is not a migration, and a committed plan each turn the check red", () => {
  const f = fixture();
  try {
    renameSync(join(f.dir, "0138_base_tip.sql"), join(f.dir, "0138_renamed.sql"));
    assert.match(check(f), /0138_base_tip\.sql is on \S+ and is gone or renamed here/);
    renameSync(join(f.dir, "0138_renamed.sql"), join(f.dir, "0138_base_tip.sql"));
    assert.equal(check(f), "");
    put(f.repo, `${DIR}/notes.txt`, "x");
    put(f.repo, `${DIR}/APPLY.md`, "# a committed plan\n");
    assert.match(check(f), /migrations\/notes\.txt is not a migration file, README\.md, apply-notes\.json, RESERVED\.json or down\//);
    assert.match(check(f), /migrations\/APPLY\.md is not a migration file/);
    rmSync(join(f.dir, "notes.txt"));
    rmSync(join(f.dir, "APPLY.md"));
    assert.equal(check(f), "");
    assert.match((planCheck(f.dir, { base: "origin/nowhere", cwd: f.repo }) as string[]).join("\n"), /cannot read \S+ at origin\/nowhere/, "an unreadable base is a problem, never a pass");
  } finally {
    cleanup(f.repo);
  }
});

test("a file above the README boundary without a change line fails the migration checks, a README row above the boundary fails them, and a file up to it still needs its row", () => {
  const f = fixture();
  try {
    put(f.repo, `${DIR}/0139_nochange.sql`, migration("0139", null));
    assert.match(migrationProblems(f.dir).join("\n"), /0139_nochange\.sql has no `-- change: <text>` line/);
    put(f.repo, `${DIR}/0139_nochange.sql`, migration("0139"));
    assert.deepEqual(migrationProblems(f.dir), []);
    const readme = readFileSync(join(f.dir, "README.md"), "utf8");
    put(f.repo, `${DIR}/README.md`, `${readme}\n| 0139_nochange | a row that must not be here | 0139-planted |\n`);
    assert.match(migrationProblems(f.dir).join("\n"), /README\.md has a row for 0139_nochange, above 0134: the table is frozen/);
    put(f.repo, `${DIR}/README.md`, readme);
    put(f.repo, `${DIR}/0099_old.sql`, migration("0099", null));
    assert.match(migrationProblems(f.dir).join("\n"), /README\.md does not list 0099_old\.sql/);
  } finally {
    cleanup(f.repo);
  }
});

// ---- INV-APPLY-2 ----
/** Two branches off one base each add a numbered migration; `legacy` is the layout this slice removed (a README row appended and the committed plan regenerated). Returns the merge's exit status and output. */
function twoBranches(layout: "derived" | "legacy") {
  const repo = mkdtempSync(join(tmpdir(), "apply-2-"));
  try {
    if (layout === "derived") {
      cpSync(REAL, join(repo, DIR), BELOW_BOUNDARY);
      pruneNotes(repo);
      const rows = JSON.parse(readFileSync(join(REAL, "RESERVED.json"), "utf8")).reservations;
      writeLedger(repo, [...rows, entry("9001", "ONE", "reserved"), entry("9002", "TWO", "reserved")]);
    } else {
      put(repo, `${DIR}/README.md`, "| file | change |\n|---|---|\n| 0001_a | a |\n| 0002_b | b |\n");
      put(repo, `${DIR}/APPLY.md`, "# Cutover apply plan\n\n| # | file |\n|---|---|\n| 1 | 0001_a |\n| 2 | 0002_b |\n");
      put(repo, `${DIR}/0001_a.sql`, migration("0001"));
      put(repo, `${DIR}/0002_b.sql`, migration("0002"));
    }
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    const add = (branch: string, n: string, name: string) => {
      git(repo, "checkout", "-q", "-b", branch, base);
      put(repo, `${DIR}/${n}_${name}.sql`, migration(n));
      if (layout === "derived") put(repo, `${DIR}/down/${n}.sql`, `DROP TABLE IF EXISTS ${name};\n`);
      else {
        put(repo, `${DIR}/README.md`, `${readFileSync(join(repo, DIR, "README.md"), "utf8")}| ${n}_${name} | ${name} |\n`);
        put(repo, `${DIR}/APPLY.md`, `${readFileSync(join(repo, DIR, "APPLY.md"), "utf8")}| ${Number(n)} | ${n}_${name} |\n`);
      }
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", branch);
    };
    const [a, b] = layout === "derived" ? [["9001", "one"], ["9002", "two"]] : [["0003", "one"], ["0004", "two"]];
    add("a", a![0]!, a![1]!);
    add("b", b![0]!, b![1]!);
    git(repo, "checkout", "-q", "a");
    const merge = spawnSync("git", ["-c", "user.name=Claude", "-c", "user.email=noreply@anthropic.com", "-c", "core.autocrlf=false", "merge", "--no-edit", "b"], { cwd: repo, encoding: "utf8" });
    const status = git(repo, "status", "--porcelain");
    const after = layout === "derived" ? spawnSync(process.execPath, [join(ROOT, "scripts/ci/apply-plan.mjs"), "--check", "--base", base], { cwd: repo, encoding: "utf8" }) : null;
    return { merged: merge.status, out: `${merge.stdout}${merge.stderr}`.trim(), status, check: after };
  } finally {
    cleanup(repo);
  }
}

test("INV-APPLY-2: two branches that each add a numbered migration and its down file merge without a conflict, the tree is clean and the check on the merge is green", () => {
  const r = twoBranches("derived");
  assert.equal(r.merged, 0, r.out);
  assert.equal(r.status, "", "a clean tree after the merge");
  assert.equal(r.check?.status, 0, `${r.check?.stdout}${r.check?.stderr}`);
  assert.match(r.check?.stdout ?? "", /apply-plan: clean/);
});

test("INV-APPLY-2 attack: the same two-branch merge on the layout this slice removed (a README row appended, the committed plan regenerated) conflicts", () => {
  const r = twoBranches("legacy");
  assert.notEqual(r.merged, 0);
  assert.match(r.out, /CONFLICT \(content\): Merge conflict in supabase\/migrations\/(README|APPLY)\.md/);
});
