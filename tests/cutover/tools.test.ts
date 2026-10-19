// The cutover tooling (P2-15 PART A): the apply plan, the APPLIED.json writer, the table export, the Edge Function bundle check, and the structure rules the single homes depend on. Each tool is tried with its failure planted.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error plain .mjs modules
import { planProblems, planText, reversalOf, selfCheckOf } from "../../scripts/ci/apply-plan.mjs";
// @ts-expect-error plain .mjs modules
import { DECLARED } from "../../scripts/ci/edge-bundle.mjs";
// @ts-expect-error plain .mjs modules
import { borrowedRowProblems, migrationProblems } from "../../scripts/ci/migration-checks.mjs";
// @ts-expect-error plain .mjs modules
import { appliedMigrations, retiredWaiverProblems } from "../../scripts/ci/waiver-check.mjs";
// @ts-expect-error plain .mjs modules
import { exportRows, renderExport, runExport } from "../../scripts/cutover/export-table.mjs";
// @ts-expect-error plain .mjs modules
import { appliedDocument } from "../../scripts/cutover/write-applied.mjs";

const MIGRATIONS = "supabase/migrations";
const sqlFiles = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [join(dir, e.name).split("\\").join("/")] : []));

// ---- the apply plan ----
test("APPLY.md lists every migration file once: the schema files in name order, then the data files after them, with the command, the self-check and the rollback of each; the held ones say what they wait for", () => {
  const text = readFileSync(`${MIGRATIONS}/APPLY.md`, "utf8").replace(/\r\n/g, "\n");
  assert.equal(text, planText(), "the committed plan is the generated one");
  const rows = text.split("\n").filter((l) => /^\| \d+ \| \d{4}_/.test(l)).map((l) => l.split(" | "));
  assert.deepEqual(rows.map((r) => `${r[1]}.sql`), [...sqlFiles.filter((f) => !f.includes("_data_")), ...sqlFiles.filter((f) => f.includes("_data_"))], "schema in name order, then data in name order");
  assert.equal(new Set(rows.map((r) => r[1])).size, sqlFiles.length, "every file once");
  for (const r of rows) assert.match(r[3] ?? "", /^`supabase db query --linked -f supabase\/migrations\/\d{4}_\S+\.sql`$/);
  const held = rows.filter((r) => /HOLD:/.test(r[r.length - 1] ?? "")).map((r) => r[1]);
  assert.deepEqual(held, ["0066_profiles_email_lower_unique", "0067_drop_coverage_gap_census_findings"]);
  assert.match(text, /duplicate-emails\.sql/);
  assert.match(text, /export-table\.mjs coverage_gap_census_findings/);
  // The waiver section is derived from approved-changes.json at this moment, never a literal: "N ... name <migration>" lines while waivers stand, "- none" once they are retired.
  const stood: Record<string, number> = {};
  for (const a of JSON.parse(readFileSync("tests/parity/approved-changes.json", "utf8")).approved.filter((w: { kind: string }) => w.kind === "until-migration")) stood[a.migration] = (stood[a.migration] ?? 0) + 1;
  const expectedWaiverLines = Object.keys(stood).length
    ? Object.entries(stood).map(([m, c]) => `- ${c} \`until-migration\` waiver(s) in tests/parity/approved-changes.json name ${m}: once APPLIED.json lists ${m} the tree check fails until they are deleted, and zero may remain.`)
    : ["- none"];
  assert.deepEqual(text.split("## Parity waivers this plan retires\n\n")[1]?.split("\n").filter(Boolean), expectedWaiverLines, "the waiver section equals what the waivers say now");
});

test("the plan is generated, so it cannot drift: a file added without a README row, an APPLY.md that differs, and a data file with no consumer note are each a problem", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-plan-"));
  try {
    cpSync(MIGRATIONS, dir, { recursive: true });
    assert.deepEqual(migrationProblems(dir), []);
    writeFileSync(join(dir, "APPLY.md"), `${readFileSync(join(dir, "APPLY.md"), "utf8")}\nedited by hand\n`);
    assert.match(migrationProblems(dir).join("|"), /APPLY\.md differs from the directory/);
    cpSync(`${MIGRATIONS}/APPLY.md`, join(dir, "APPLY.md"));
    writeFileSync(join(dir, "0099_planted.sql"), "-- 0099 planted\nBEGIN;\nCOMMIT;\n");
    assert.match(migrationProblems(dir).join("|"), /README\.md does not list 0099_planted\.sql/);
    assert.match(migrationProblems(dir).join("|"), /APPLY\.md differs/, "the new file is not in the plan either");
    rmSync(join(dir, "0099_planted.sql"));
    writeFileSync(join(dir, "0099_data_planted.sql"), "-- 0099 DATA\nBEGIN;\nCOMMIT;\n");
    assert.match(planProblems(dir).join("|"), /the data file 0099_data_planted\.sql needs a "consumer" and an "after"/);
    writeFileSync(join(dir, "apply-notes.json"), JSON.stringify({ ...JSON.parse(readFileSync(`${MIGRATIONS}/apply-notes.json`, "utf8")), "0098_nothing": { hold: "x" } }));
    assert.match(planProblems(dir).join("|"), /names 0098_nothing, which is not a file/);
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
  assert.deepEqual(migrationProblems(MIGRATIONS).filter((p) => /borrows a live row|IS NOT NULL THEN/.test(p)), [], "no merged migration borrows a live row");
});

test("a file's self-check and rollback are read from the file, not typed: the id its OK notice prints, the Reversal header with its continuation lines", () => {
  assert.equal(selfCheckOf("DO $$ BEGIN RAISE NOTICE '0064-host-worklist OK'; END $$;"), "0064-host-worklist");
  assert.equal(selfCheckOf("no notice here"), "none");
  assert.equal(reversalOf("-- Reversal: DROP TABLE a;\n-- DROP TABLE b.\n\n-- next"), "DROP TABLE a; DROP TABLE b.");
  assert.equal(reversalOf("-- Idempotent. Reversal: UPDATE x SET y = NULL.\n-- catalog: none"), "UPDATE x SET y = NULL.");
  assert.equal(reversalOf("-- nothing"), "none");
  const unnamed = sqlFiles.filter((f) => selfCheckOf(readFileSync(`${MIGRATIONS}/${f}`, "utf8")) === "none");
  assert.deepEqual(unnamed, ["0030_data_market_series_items.sql"], "every other file ends in a self-check that names itself; this one prints none and the plan says so");
});

// ---- APPLIED.json ----
test("APPLIED.json is written from the run's list of applied files as the 4-digit numbers the waivers name; a name that is not a file, or an empty list, is refused; once it lists 0031 the waivers of 0031 fail the tree check", () => {
  const ok = appliedDocument(["0031_member_detail_reads.sql", "0030_data_market_series_items", "", "0031_member_detail_reads.sql"], sqlFiles);
  assert.deepEqual([ok.problems, ok.doc], [[], { applied: ["0030", "0031"] }]);
  assert.match(appliedDocument(["0031_member_detail_reads.sql", "0999_nope.sql"], sqlFiles).problems.join("|"), /0999_nope\.sql is not a file/);
  assert.match(appliedDocument([""], sqlFiles).problems.join("|"), /names no migration/);
  // The expectation is derived from APPLIED.json's presence and contents, not from a phase.
  type Waivers = { approved: { id: string; kind: string; migration?: string }[] };
  const waiverStateProblems = (dir: string, cfg: Waivers): string[] => {
    const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f));
    const numbers = new Set(files.map((f) => f.slice(0, 4)));
    const waivers = cfg.approved.filter((a) => a.kind === "until-migration");
    if (!existsSync(`${dir}/APPLIED.json`)) return waivers.filter((a) => !numbers.has(String(a.migration))).map((a) => `waiver ${a.id} names ${a.migration}, which is not a migration in the directory`);
    const applied = appliedMigrations(JSON.parse(readFileSync(`${dir}/APPLIED.json`, "utf8")));
    return [
      ...[...applied].filter((n) => !numbers.has(n)).map((n) => `APPLIED.json lists ${n}, which is not a migration in the directory`),
      ...retiredWaiverProblems(cfg, applied),
    ];
  };
  const fixture = (withApplied: string[] | null) => {
    const d = mkdtempSync(join(tmpdir(), "waiver-"));
    writeFileSync(join(d, "0031_x.sql"), "-- fixture\n");
    if (withApplied) writeFileSync(join(d, "APPLIED.json"), JSON.stringify({ applied: withApplied }));
    return d;
  };
  const standing: Waivers = { approved: [{ id: "w1", kind: "until-migration", migration: "0031" }] };
  const dangling: Waivers = { approved: [{ id: "w2", kind: "until-migration", migration: "0099" }] };
  const none: Waivers = { approved: [{ id: "p1", kind: "other" }] };
  const absent = fixture(null);
  const present = fixture(["0031"]);
  const phantom = fixture(["0031", "0099"]);
  try {
    assert.deepEqual(waiverStateProblems(absent, standing), [], "APPLIED.json absent: a waiver naming a migration that exists stands");
    assert.equal(waiverStateProblems(absent, dangling).length, 1, "APPLIED.json absent: a waiver naming a migration that is not in the directory is refused");
    assert.equal(waiverStateProblems(present, standing).length, 1, "APPLIED.json present: a waiver naming a listed migration is refused (zero may remain)");
    assert.deepEqual(waiverStateProblems(present, none), [], "APPLIED.json present: no until-migration waiver left is clean");
    assert.equal(waiverStateProblems(phantom, none).length, 1, "APPLIED.json present: an entry that is not a file is refused");
  } finally {
    for (const d of [absent, present, phantom]) rmSync(d, { recursive: true, force: true });
  }
  const config = JSON.parse(readFileSync("tests/parity/approved-changes.json", "utf8"));
  assert.deepEqual(waiverStateProblems(MIGRATIONS, config), [], "the real directory and waivers agree with whether APPLIED.json exists");
  assert.equal(retiredWaiverProblems(standing, appliedMigrations(ok.doc)).length, 1, "a waiver of 0031 fails the check once 0031 is listed");
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
