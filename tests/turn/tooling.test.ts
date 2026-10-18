// The checks and the tools this slice ships, each proven by attack: a planted violation must fail (rule 15), a clean tree must pass.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { ESLint } from "eslint";

import { foldRun, insideLongerNumber } from "@/core/contracts";
import { checkRateLimit } from "@/core/http/rate-limit";

import { MemDb } from "../_support/memdb.ts";

const { CONTROL } = (await import(pathToFileURL(resolve(import.meta.dirname, "../../scripts/gen/json-data.mjs")).href)) as { CONTROL: RegExp };

const ROOT = resolve(import.meta.dirname, "../..");
const script = (name: string) => join(ROOT, "scripts", name);
const scratch = () => mkdtempSync(join(tmpdir(), "p208-"));
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

// ── the connection check ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function tree(over: { families?: unknown; extra?: Record<string, string>; stages?: string } = {}): string {
  const dir = scratch();
  const families = over.families ?? [{ name: "a", owner: "x", stage: "one", downstream: ["b"], writes: [] }, { name: "b", owner: "x", stage: "two", downstream: [], terminal: "the end", writes: [] }];
  put(dir, "scripts/ci/connections-allow.json", JSON.stringify({ entries: {}, written: [] }));
  put(dir, "src/core/harness/data/families.json", JSON.stringify(families));
  put(dir, "src/core/turn/registry.ts", `export const STAGES = ${over.stages ?? '["one", "two"]'} as const;\n`);
  put(dir, "src/core/turn/stages/one.ts", 'import { runFoo } from "@/features/foo/run";\nexport const x = runFoo;\n');
  put(dir, "src/features/foo/run.ts", 'import type { RunResult } from "@/core/types/run-result";\nexport async function runFoo(deps: unknown, input: unknown): Promise<RunResult> {\n  return { counts: {}, outcome: "ok", notes: [] };\n}\n');
  put(dir, "src/core/types/run-result.ts", "export interface RunResult { counts: Record<string, number>; outcome: string; notes: string[] }\n");
  for (const [rel, text] of Object.entries(over.extra ?? {})) put(dir, rel, text);
  return dir;
}
const connections = (dir: string) => spawnSync(process.execPath, [script("ci/connections.mjs")], { cwd: dir, encoding: "utf8" });

test("the connection check: a clean tree passes and prints the map", () => {
  const r = connections(tree());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| one \| a \| b \|/);
  assert.match(r.stdout, /1 runtime entries, 1 called/);
});

test("the connection check ATTACKS: an uncalled runtime, a stage that ends with no reason, a stage that does not hand to the next, and a surface reader of an unwritten table each fail", () => {
  const uncalled = connections(tree({ extra: { "src/features/bar/job.ts": 'import type { RunResult } from "@/core/types/run-result";\nexport async function runBar(deps: unknown): Promise<RunResult> {\n  return { counts: {}, outcome: "ok", notes: [] };\n}\n' } }));
  assert.equal(uncalled.status, 1);
  assert.match(uncalled.stderr, /runBar is a runtime entry with no caller/);
  const endless = connections(tree({ families: [{ name: "a", owner: "x", stage: "one", downstream: ["b"], writes: [] }, { name: "b", owner: "x", stage: "two", downstream: [], writes: [] }] }));
  assert.match(endless.stderr, /stage two \(family b\) records no downstream and no reason it ends/);
  const broken = connections(tree({ families: [{ name: "a", owner: "x", stage: "one", downstream: [], terminal: "x", writes: [] }, { name: "b", owner: "x", stage: "two", downstream: [], terminal: "x", writes: [] }] }));
  assert.match(broken.stderr, /stage one does not hand off to the next stage two/);
  const engine = connections(tree({ extra: { "src/features/page/read/page.ts": 'export const q = (db: any) => db.from("ghost_table").select("id");\n' } }));
  assert.equal(engine.status, 1);
  assert.match(engine.stderr, /reads ghost_table, which no machine stage, route or runtime writes/);
  const fed = connections(tree({ extra: { "src/features/page/read/page.ts": 'export const q = (db: any) => db.from("real_table").select("id");\n', "src/features/foo/write.ts": 'export const w = (db: any) => db.from("real_table").insert({ a: 1 });\n' } }));
  assert.equal(fed.status, 0, fed.stderr);
});

test("the shipped tree passes its own connection check", () => {
  const r = spawnSync(process.execPath, [script("ci/connections.mjs")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

// ── generated data and migrations ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("the migration checks: the committed set passes; a file the README does not list, a README row with no file, a hand-edited generated row, and a generated file without its header each fail", async () => {
  const { migrationProblems } = await import(`${script("ci/migration-checks.mjs")}`.replace(/^(\w):/, "file:///$1:"));
  assert.deepEqual(migrationProblems(join(ROOT, "supabase/migrations")), []);
  const dir = scratch();
  const real = join(ROOT, "supabase/migrations");
  writeFileSync(join(dir, "README.md"), readFileSync(join(real, "README.md"), "utf8"));
  const gen = readFileSync(join(real, "0015_data_screen_verdicts.sql"), "utf8");
  writeFileSync(join(dir, "0015_data_screen_verdicts.sql"), gen);
  const some = migrationProblems(dir);
  assert.ok(some.filter((p: string) => !p.includes("APPLY.md") && !p.includes("apply-notes.json")).every((p: string) => p.includes("README.md lists")), "only the files absent from the scratch dir are reported (the cutover plan has its own tests, tests/cutover/tools.test.ts)");
  writeFileSync(join(dir, "0099_new.sql"), "-- nothing\n");
  assert.ok(migrationProblems(dir).includes(`${dir}/README.md does not list 0099_new.sql`));
  writeFileSync(join(dir, "0015_data_screen_verdicts.sql"), gen.replace(/^\('([0-9a-f-]{36})', 'on_vertical'/m, "('$1', 'off_vertical'"));
  assert.ok(migrationProblems(dir).some((p: string) => p.startsWith("0015_data_screen_verdicts.sql:") && /hash|byte for byte/.test(p)));
  writeFileSync(join(dir, "0015_data_screen_verdicts.sql"), gen.replace(/^-- source-export:.*$/m, "-- (header removed)"));
  assert.ok(migrationProblems(dir).some((p: string) => p.includes("no `-- source-export:` header")));
  writeFileSync(join(dir, "0016_data_gen.sql"), "-- GENERATED by a tool\n");
  assert.ok(migrationProblems(dir).some((p: string) => p === "0016_data_gen.sql: no verifier for generator a"));
  writeFileSync(join(dir, "0016_data_gen.sql"), "-- GENERATED by scripts/gen/bogus.mjs from x\n");
  assert.ok(migrationProblems(dir).some((p: string) => p === "0016_data_gen.sql: no verifier for generator scripts/gen/bogus.mjs"), "an unknown generator never passes silently");
});

test("the generated JSON writer: a value that does not round trip, or a string with a control character, is refused", async () => {
  const { renderJsonData } = await import(`${script("gen/json-data.mjs")}`.replace(/^(\w):/, "file:///$1:"));
  assert.equal(renderJsonData({ a: ["b"] }), '{\n "a": [\n  "b"\n ]\n}\n');
  assert.throws(() => renderJsonData({ pattern: "a\u0001b" }), /control character/);
  assert.throws(() => renderJsonData({ "bad\u0008key": 1 }), /control character/);
  assert.throws(() => renderJsonData({ n: undefined, m: () => 1 } as never), /does not parse back|control/);
});

test("every JSON data file under src parses and carries no control character in a string (the two regex files that shipped with invalid escapes)", () => {
  const out = execFileSync("git", ["ls-files", "src/**/*.json"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(out.length > 40);
  for (const f of out) {
    const strings: string[] = [];
    JSON.parse(readFileSync(join(ROOT, f), "utf8"), (_k, v) => (typeof v === "string" && strings.push(v), v));
    assert.deepEqual(strings.filter((s) => CONTROL.test(s)).slice(0, 1), [], `${f} carries a control character`);
  }
});

// ── the shared test database ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("the shared memory database refuses what the database refuses: an unknown table, a column the insert, the filter or the select list names, and fills the defaults the schema gives", async () => {
  const db = new MemDb();
  assert.throws(() => db.from("no_such_table"), /relation "no_such_table" does not exist/);
  assert.throws(() => db.seed("sources", [{ id: "s", urll: "x" }]), /column "urll" of relation "sources"/);
  assert.throws(() => (db.from("sources") as { eq(c: string, v: string): unknown }).eq("nope", "x"), /column "nope" of relation "sources"/);
  assert.throws(() => (db.from("intelligence_items") as { select(c: string): unknown }).select("id, effective_priority"), /column "effective_priority" of relation "intelligence_items"/);
  await (db.from("market_series") as { insert(r: unknown): PromiseLike<unknown> }).insert({ series_key: "k", label: "l" });
  const row = db.rows("market_series")[0]!;
  assert.match(String(row.id), /^[0-9a-f-]{36}$/, "the uuid default");
  assert.equal(typeof row.created_at, "string", "the now() default");
  await (db.from("intelligence_items") as { insert(r: unknown): PromiseLike<unknown> }).insert({ title: "T" });
  assert.deepEqual([db.rows("intelligence_items")[0]?.is_archived, db.rows("intelligence_items")[0]?.item_grade], [false, "brief"]);
  db.views.v = () => [{ a: 1 }];
  assert.deepEqual(db.rows("v"), [{ a: 1 }]);
});

// ── the shared rate limiter's per-route budget (IMP-057) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("a route's own budget goes through rate_limit_hit and into the headers; the default stays 60", async () => {
  const sent: Record<string, unknown>[] = [];
  const db = { rpc: async (_n: string, args: Record<string, unknown>) => (sent.push(args), { data: [{ allowed: sent.length <= 2, remaining: Math.max(0, 2 - sent.length), reset_at: new Date(Date.now() + 30_000).toISOString() }], error: null }) } as never;
  assert.equal(await checkRateLimit("k1", Date.now(), db, { limit: 2, windowMs: 30_000 }), null);
  assert.equal(await checkRateLimit("k1", Date.now(), db, { limit: 2, windowMs: 30_000 }), null);
  const denied = await checkRateLimit("k1", Date.now(), db, { limit: 2, windowMs: 30_000 });
  assert.equal(denied?.status, 429);
  assert.equal(denied?.headers.get("x-ratelimit-limit"), "2");
  assert.deepEqual(sent[0], { p_key: "k1", p_limit: 2, p_window_seconds: 30 });
  await checkRateLimit("k2", Date.now(), db);
  assert.deepEqual([sent[3]?.p_limit, sent[3]?.p_window_seconds], [60, 60]);
  // In memory (no shared counter) the same budget applies.
  const local = [await checkRateLimit("k3", 1000, null, { limit: 1 }), await checkRateLimit("k3", 1001, null, { limit: 1 })];
  assert.deepEqual([local[0], local[1]?.status], [null, 429]);
});

// ── the empty-catch rule ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("the lint rule: a catch that swallows (empty, or only a comment) fails; a catch that records, returns or rethrows passes", async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string) => (await eslint.lintText(code, { filePath: join(ROOT, "src/core/shared/example.ts") }))[0]?.messages.filter((m) => m.ruleId === "no-restricted-syntax" || m.ruleId === "no-empty") ?? [];
  assert.equal((await lint("export function a() {\n  try {\n    JSON.parse('x');\n  } catch {\n  }\n}\n")).length > 0, true);
  assert.equal((await lint("export function a() {\n  try {\n    JSON.parse('x');\n  } catch {\n    // fall through\n  }\n}\n")).length > 0, true, "a comment is not a body");
  assert.equal((await lint("export function a() {\n  try {\n    return JSON.parse('x');\n  } catch {\n    return null;\n  }\n}\n")).length, 0);
  assert.equal((await lint("export function a() {\n  try {\n    return JSON.parse('x');\n  } catch (e) {\n    throw new Error('bad', { cause: e });\n  }\n}\n")).length, 0);
});

test("the lint rule (IMP-106): outside the coverage feature, a path into its server, ui or api directory fails; its two barrels, and the feature's own files, pass", async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string, file: string) => (await eslint.lintText(code, { filePath: join(ROOT, file) }))[0]?.messages.filter((m) => m.ruleId === "no-restricted-imports") ?? [];
  for (const path of ["server/matrix-data", "server/census", "ui/DenominatorLine", "ui/CoveragePage", "api/entries", "page"]) {
    assert.equal((await lint(`import * as x from "@/features/coverage/${path}";\nexport { x };\n`, "src/features/market/example.ts")).length, 1, path);
  }
  assert.equal((await lint('import { loadSurfaceDenominator } from "@/features/coverage/server";\nimport { DenominatorLine } from "@/features/coverage";\nexport { loadSurfaceDenominator, DenominatorLine };\n', "src/features/market/example.ts")).length, 0);
  assert.equal((await lint('import { x } from "@/features/coverage/server/matrix-data";\nexport { x };\n', "src/features/coverage/example.ts")).length, 0, "the feature reaches its own files");
});

// ── moved code keeps its behaviour ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("the number rule beside isVerbatim: a figure folds only when its value is unchanged, and a match never starts or ends inside a longer number", () => {
  assert.equal(foldRun("1,200,000").text, "1200000");
  assert.equal(foldRun("1 200 000").text, "1200000");
  assert.equal(foldRun("12.345").text, "12.345", "a single ambiguous separator never folds");
  assert.equal(insideLongerNumber("total 12,345 units", 9, 12), true, "345 inside 12,345");
  assert.equal(insideLongerNumber("total 12,345 units", 6, 12), false);
});

test("the sources backfill is verified by its own generator's header and statement count, not the screen-verdicts rule (P2-15i)", async () => {
  const { migrationProblems } = await import(`${script("ci/migration-checks.mjs")}`.replace(/^(\w):/, "file:///$1:"));
  const { spawnSync } = await import("node:child_process");
  const gen = spawnSync(process.execPath, ["--import", "./tests/_support/register.mjs", "scripts/gen/source-backfill-sql.mjs", "scripts/ci/fixtures/sources-export-sample.json", "the sample export"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);
  const sql = gen.stdout;
  assert.match(sql, /^-- source-export: scripts\/ci\/fixtures\/sources-export-sample\.json \(sha256 [0-9a-f]{64}\)$/m);
  assert.equal(spawnSync(process.execPath, ["--import", "./tests/_support/register.mjs", "scripts/gen/source-backfill-sql.mjs", "scripts/ci/fixtures/sources-export-sample.json", "the sample export"], { cwd: ROOT, encoding: "utf8" }).stdout, sql, "deterministic from the export");
  const dir = scratch();
  writeFileSync(join(dir, "README.md"), readFileSync(join(ROOT, "supabase/migrations/README.md"), "utf8"));
  const mine = (text: string) => { writeFileSync(join(dir, "0016_data_source_type_backfill.sql"), text); return migrationProblems(dir).filter((p: string) => p.startsWith("0016_data_source_type_backfill.sql:")); };
  assert.deepEqual(mine(sql), []);
  assert.ok(mine(sql.replace(/^-- source-export:.*\n/m, "")).some((p: string) => p.includes("no `-- source-export:` header")), "the pre-fix output (no header) fails");
  assert.ok(mine(sql.replace(/^UPDATE public\.sources SET source_type = .*\n/m, "")).some((p: string) => /source_type UPDATE statements/.test(p)), "a dropped statement fails");
  assert.ok(mine(sql.replace(/^(UPDATE public\.sources SET source_role = .*\n)/m, "$1$1")).some((p: string) => /source_role UPDATE statements/.test(p)), "a duplicated statement fails");
  assert.ok(mine(sql.replace("scripts/gen/source-backfill-sql.mjs", "scripts/gen/other.mjs")).some((p: string) => p.includes("no verifier for generator scripts/gen/other.mjs")));
});
