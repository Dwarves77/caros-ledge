// The cutover tooling (P2-15 PART A): the apply plan, the table export, the Edge Function bundle check, and the structure rules the single homes depend on. Each tool is tried with its failure planted.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error plain .mjs modules
import { changesText, pendingFiles, planOrder, planProblems, planText, rollbackOf, selfCheckOf } from "../../scripts/ci/apply-plan.mjs";
// @ts-expect-error plain .mjs modules
import { DECLARED } from "../../scripts/ci/edge-bundle.mjs";
// @ts-expect-error plain .mjs modules
import { borrowedRowProblems, migrationProblems } from "../../scripts/ci/migration-checks.mjs";
// @ts-expect-error plain .mjs modules
import { exportRows, renderExport, runExport } from "../../scripts/cutover/export-table.mjs";

const MIGRATIONS = "supabase/migrations";
const sqlFiles = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [join(dir, e.name).split("\\").join("/")] : []));

// ---- the apply plan: derived, never committed ----
test("the apply plan is derived from the directory: no committed copy exists, two derivations are byte-equal whatever order the directory was written in, schema files in name order then data files in name order, every file once, the held ones say what they wait for", () => {
  assert.ok(!existsSync(`${MIGRATIONS}/APPLY.md`), "no generated plan is committed");
  const text: string = planText();
  const dir = mkdtempSync(join(tmpdir(), "apply-plan-"));
  try {
    mkdirSync(join(dir, "down"));
    for (const f of [...readdirSync(MIGRATIONS)].reverse()) if (f !== "down") cpSync(join(MIGRATIONS, f), join(dir, f));
    for (const f of [...readdirSync(`${MIGRATIONS}/down`)].reverse()) cpSync(join(MIGRATIONS, "down", f), join(dir, "down", f));
    assert.equal(planText(dir), text, "the same plan from a directory written in the opposite order");
    assert.deepEqual(planOrder(dir), planOrder(MIGRATIONS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const rows = text.split("\n").filter((l) => /^\| \d+ \| \d{4}_/.test(l)).map((l) => l.split(" | "));
  assert.deepEqual(rows.map((r) => `${r[1]}.sql`), [...sqlFiles.filter((f) => !f.includes("_data_")), ...sqlFiles.filter((f) => f.includes("_data_"))], "schema in name order, then data in name order");
  assert.equal(new Set(rows.map((r) => r[1])).size, sqlFiles.length, "every file once");
  for (const r of rows) {
    assert.match(r[3] ?? "", /^`supabase db query --linked -f supabase\/migrations\/\d{4}_\S+\.sql`$/);
    assert.ok((r[4] ?? "").length > 0 && (r[5] ?? "").length > 0, `${r[1]} has a self-check cell and a rollback cell`);
  }
  const held = rows.filter((r) => /HOLD:/.test(r[r.length - 1] ?? "")).map((r) => r[1]);
  assert.deepEqual(held, ["0066_profiles_email_lower_unique", "0067_drop_coverage_gap_census_findings"]);
  assert.deepEqual(sqlFiles.filter((f) => !pendingFiles(MIGRATIONS, new Set()).includes(f)), held.map((h) => `${h}.sql`), "a held file is in the plan and not pending");
  assert.match(text, /duplicate-emails\.sql/);
  assert.match(text, /export-table\.mjs coverage_gap_census_findings/);
  assert.match(changesText(MIGRATIONS), /\| 0134_connect_2_spine \| entity_refs\.basis/, "the changes table reads the frozen README rows");
});

test("the plan check derives in memory: a data file with no consumer note, an apply-notes row naming no file, an empty hold and a hold that names no step are each a problem; the unchanged directory is clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-plan-"));
  try {
    cpSync(MIGRATIONS, dir, { recursive: true });
    assert.deepEqual(migrationProblems(dir), []);
    writeFileSync(join(dir, "0099_planted.sql"), "-- 0099 planted\nBEGIN;\nCOMMIT;\n");
    assert.match(migrationProblems(dir).join("|"), /README\.md does not list 0099_planted\.sql/);
    rmSync(join(dir, "0099_planted.sql"));
    writeFileSync(join(dir, "0099_data_planted.sql"), "-- 0099 DATA\nBEGIN;\nCOMMIT;\n");
    assert.match(planProblems(dir).join("|"), /the data file 0099_data_planted\.sql needs a "consumer" and an "after"/);
    const notes = JSON.parse(readFileSync(`${MIGRATIONS}/apply-notes.json`, "utf8"));
    const withNotes = (extra: object) => writeFileSync(join(dir, "apply-notes.json"), JSON.stringify({ ...notes, ...extra }));
    withNotes({ "0098_nothing": { note: "x" } });
    assert.match(planProblems(dir).join("|"), /names 0098_nothing, which is not a file/);
    withNotes({ "0066_profiles_email_lower_unique": { hold: " " } });
    assert.match(planProblems(dir).join("|"), /0066_profiles_email_lower_unique has an empty hold/);
    withNotes({ "0066_profiles_email_lower_unique": { hold: "until somebody says so" } });
    assert.match(planProblems(dir).join("|"), /the hold on 0066_profiles_email_lower_unique names no step/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a self-check that borrows a live row, or guards its assertions behind the borrowed variable, fails (P2-15h)", () => {
  const borrowing = "DO $$ DECLARE a uuid; b uuid; BEGIN\n  SELECT id INTO a FROM public.profiles LIMIT 1;\n  SELECT id INTO b FROM public.intelligence_items\n   LIMIT 1;\n  IF a IS NOT NULL AND b IS NOT NULL THEN NULL; END IF;\nEND $$;";
  const found = borrowedRowProblems(borrowing).join("|");
  assert.match(found, /INTO a FROM public/);
  assert.match(found, /INTO b FROM public/);
  assert.match(found, /guards its assertions behind `a IS NOT NULL THEN`/);
  assert.deepEqual(borrowedRowProblems("DO $$ DECLARE a uuid := gen_random_uuid(); BEGIN INSERT INTO auth.users (id) VALUES (a); SELECT id INTO a FROM public.profiles WHERE id = a; END $$;"), []);
  const dir = mkdtempSync(join(tmpdir(), "borrow-"));
  try {
    cpSync(MIGRATIONS, dir, { recursive: true });
    writeFileSync(join(dir, "0099_borrow.sql"), borrowing);
    assert.match(migrationProblems(dir).join("|"), /0099_borrow\.sql: the self-check borrows a live row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(migrationProblems(MIGRATIONS).filter((p: string) => /borrows a live row|IS NOT NULL THEN/.test(p)), [], "no merged migration borrows a live row");
});

test("a file's self-check and rollback are read from the file, not typed: the id its OK notice prints or its Self-check header names; the down file, or the irreversible marker with its recovery; a prose header is no rollback", () => {
  assert.equal(selfCheckOf("DO $$ BEGIN RAISE NOTICE '0064-host-worklist OK'; END $$;"), "0064-host-worklist");
  assert.equal(selfCheckOf("-- Self-check 0099-named\nSELECT 1;", "0099_x.sql"), "0099-named");
  assert.equal(selfCheckOf("no notice here"), "none");
  const dir = mkdtempSync(join(tmpdir(), "rollback-"));
  try {
    mkdirSync(join(dir, "down"));
    writeFileSync(join(dir, "down", "0098.sql"), "DROP TABLE a;\n");
    assert.match(rollbackOf("0098_x.sql", "-- schema\n", {}, dir), /^down\/0098\.sql, applied and catalog-compared by the schema job$/);
    assert.equal(rollbackOf("0099_x.sql", "-- irreversible: restore the table from the export taken at step 3\n", {}, dir), "irreversible: restore the table from the export taken at step 3");
    assert.equal(rollbackOf("0099_x.sql", "-- schema\n", { "0099_x": { irreversible: "the apply note names the recovery" } }, dir), "irreversible: the apply note names the recovery");
    assert.equal(rollbackOf("0099_x.sql", "-- Reversal: DROP TABLE a;\n", {}, dir), "none", "a prose Reversal header is not a rollback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const unnamed = sqlFiles.filter((f) => selfCheckOf(readFileSync(`${MIGRATIONS}/${f}`, "utf8")) === "none");
  assert.deepEqual(unnamed, ["0030_data_market_series_items.sql"], "every other file ends in a self-check that names itself; this one prints none and the plan says so");
});

// ---- the export ----
const fakeDb = (rows: Record<string, unknown>[], failAt = -1) => {
  const seen: { order?: string; range?: [number, number] }[] = [];
  return {
    seen,
    from: () => ({
      select: () => ({
        order: (col: string) => ({
          range: async (from: number, to: number) => {
            seen.push({ order: col, range: [from, to] });
            if (from === failAt) return { data: null, error: { message: "page refused" } };
            return { data: rows.slice(from, to + 1), error: null };
          },
        }),
      }),
    }),
  };
};
test("the table export reads every page in key order and writes the rows with their count and sha256; a page that fails stops it and writes no file; an existing file is not overwritten", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: String(i).padStart(5, "0"), n: i }));
  const db = fakeDb(rows);
  assert.equal((await exportRows(db, "t")).length, 2500);
  assert.deepEqual(db.seen.map((s) => s.range), [[0, 999], [1000, 1999], [2000, 2999]]);
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  try {
    const out = join(dir, "logs", "x.json");
    const logs: string[] = [];
    const r = await runExport(fakeDb(rows), ["coverage_gap_census_findings", "--out", out], { log: (l: string) => logs.push(l) });
    assert.equal(r.rows, 2500);
    assert.equal(renderExport(JSON.parse(readFileSync(out, "utf8"))).sha256, r.sha256);
    assert.match(logs[0] as string, /exported 2500 row\(s\) of coverage_gap_census_findings to .*x\.json sha256 [0-9a-f]{64}/);
    await assert.rejects(() => runExport(fakeDb(rows), ["t", "--out", out]), /exists: it is not overwritten/);
    const half = join(dir, "half.json");
    await assert.rejects(() => runExport(fakeDb(rows, 1000), ["t", "--out", half]), /reading t failed at row 1000: page refused/);
    assert.ok(!existsSync(half), "a partial export is never written");
    await assert.rejects(() => runExport(fakeDb([]), ["bad table; drop"]), /usage/);
    const today = await runExport(fakeDb([{ id: "a" }]), ["t", "--out", join(dir, "d.json")], { today: "2026-11-02", log: () => {} });
    assert.equal(today.rows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the duplicate-email query is read-only and member-safe: it names no write, no column but the address and its count, and the schema job proves it against a planted duplicate", () => {
  const sql = readFileSync("scripts/cutover/duplicate-emails.sql", "utf8").replace(/^--.*$/gm, "");
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i);
  assert.match(sql, /lower\(email\)/);
  assert.match(sql, /group by 1 having count\(\*\) > 1/);
  assert.match(readFileSync("scripts/ci/schema-apply.mjs", "utf8"), /proveDuplicateEmailQuery\(\)/);
});

// ---- the Edge Function bundle ----
test("IMP-029: the worker still imports the fetch policy by a relative path and the bundle gate is a gate step; the bundle's structure checks are in tests/ci/checks.test.mjs", () => {
  assert.deepEqual([...DECLARED], ["fetchDocument", "storageMaxChars", "isServiceRoleRequest", "extractText"], "the policy's fetch, its ceiling reader, the worker's auth check and the PDF extractor");
  assert.ok(readFileSync("supabase/functions/capture-worker/process.ts", "utf8").includes('from "../../../src/core/fetch/policy.ts"'), "the worker still imports the policy by a relative path, so the Node transports and the worker share one policy");
  assert.match(readFileSync("scripts/ci/gates.mjs", "utf8"), /cmd: "edge-bundle"/);
});

// ---- the single homes ----
test("IMP-112: the codes that say a database object is absent are listed once (src/core/db/absent.ts); no other file in src or scripts carries the list", () => {
  const holders = [...walk("src"), ...walk("scripts")].filter((f) => f !== "src/core/db/absent.ts" && /"42P01"|PGRST205|"PGRST202"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(holders, []);
  assert.doesNotMatch(readFileSync("src/features/admin/api/shared.ts", "utf8"), /isMissingFunction/);
});

test("IMP-114: the unplaced hosts are written by registerAndRate through record_host_worklist and nowhere else; the exporter only reads the table", () => {
  const writers = walk("src").filter((f) => /host_worklist/.test(readFileSync(f, "utf8")));
  assert.deepEqual(writers.sort(), ["src/core/sources/register.ts", "src/features/batches/kinds/host-verdicts/export.ts"]);
  assert.doesNotMatch(readFileSync("src/features/batches/kinds/host-verdicts/export.ts", "utf8"), /\.(insert|update|upsert|delete)\(/);
  assert.match(readFileSync("src/core/sources/register.ts", "utf8"), /rpc\("record_host_worklist"/);
});

test("IMP-115: the assignments route writes through assign_item_members only: no insert into item_assignments and no second notification insert remain in it", () => {
  const code = readFileSync("src/features/workspace/api/assignments.ts", "utf8");
  assert.match(code, /rpc\("assign_item_members"/);
  assert.doesNotMatch(code, /from\("item_assignments"\)\s*\.insert|queueNotifications/);
});

test("IMP-063: the two fonts are vendored: the package dependencies and their budget lines are gone, the files and their licences sit under public/fonts, and the root layout takes the faces from src/ui/fonts.ts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.budget }).some((k) => k.startsWith("@fontsource")));
  const files = readdirSync("public/fonts");
  for (const need of ["plus-jakarta-sans-latin-400-normal.woff2", "plus-jakarta-sans-latin-ext-800-normal.woff2", "anton-latin-400-normal.woff2", "anton-latin-ext-400-normal.woff2", "OFL-anton.txt", "OFL-plus-jakarta-sans.txt"]) assert.ok(files.includes(need), need);
  assert.equal(files.filter((f) => f.startsWith("plus-jakarta-sans-") && f.endsWith(".woff2")).length, 10, "five weights, latin and latin-ext");
  const fonts = readFileSync("src/ui/fonts.ts", "utf8");
  for (const f of files.filter((x) => x.endsWith(".woff2"))) assert.ok(fonts.includes(f), `${f} is declared`);
  assert.match(readFileSync("src/app/layout.tsx", "utf8"), /className=\{fontClassNames\}/);
  assert.deepEqual(walk("src").filter((f) => /(from|import) "@fontsource/.test(readFileSync(f, "utf8"))), [], "no file imports a font package");
  assert.match(readFileSync("src/ui/theme.css", "utf8"), /--font-sans: var\(--font-jakarta\), var\(--font-jakarta-ext\)/);
});
