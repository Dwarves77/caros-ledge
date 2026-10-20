// G8: the tree, LOC, workflow, edge-bundle, scope and gate-list checks each go red on a planted violation. R1 and R4 of the 2026-10-19 audit (a package.json without its `prepare` script read "clean"; the LOC limits were never compared on
// the machine that runs the pre-push hook) are the first two cases and fail on the code as it was.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createLinter } from 'actionlint';

import { bundleExports, bundleProblems, declaredNames, sourceExports } from '../../scripts/ci/edge-bundle.mjs';
import { codeLines, limitProblems, totalsOf } from '../../scripts/ci/loc.mjs';
import { scopeOf } from '../../scripts/ci/changes.mjs';
import { STEPS } from '../../scripts/ci/gates.mjs';
import { dependencyProblems, headerRangeProblems, identifierProblems, pushGateProblems, sourceOriginProblems } from '../../scripts/ci/tree-checks.mjs';
import { textProblems } from '../../scripts/ci/workflow-yaml.mjs';

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---- tree-checks ----
test('R1: a package.json with its prepare script deleted is a problem (the check was `(!x) === "string"`, always false)', () => {
  const ok = { packageText: JSON.stringify({ scripts: { prepare: 'node scripts/prepare.mjs' } }), prepareText: 'git config core.hooksPath .githooks', hookMode: '100755' };
  assert.deepEqual(pushGateProblems(ok), []);
  assert.match(pushGateProblems({ ...ok, packageText: JSON.stringify({ scripts: {} }) }).join('|'), /prepare script .* is missing/);
  assert.match(pushGateProblems({ ...ok, packageText: JSON.stringify({ scripts: { prepare: 'echo hi' } }) }).join('|'), /prepare script/);
  assert.match(pushGateProblems({ ...ok, prepareText: 'nothing about hooks' }).join('|'), /prepare script/);
  assert.match(pushGateProblems({ ...ok, prepareText: null }).join('|'), /prepare script/);
  assert.match(pushGateProblems({ ...ok, hookMode: '100644' }).join('|'), /not executable in the index \(mode 100644/);
});

test('personal identifiers: a Windows (either slash), macOS or Linux home directory and the common mail providers are caught; a URL path and a repo directory named home are not', () => {
  // The strings are assembled from parts: written out, they would be the very identifiers the tree check refuses in this file.
  const j = (...parts) => parts.join('');
  const hit = (text) => identifierProblems('x.md', text).length > 0;
  const caught = [j('C', ':\\Users\\someone\\x'), j('C', ':', '/Users', '/someone/x'), j('c', ':/users/someone'), j('/', 'Users', '/someone/x'), j('at /', 'home/someone/project'), j('write to someone', '@', 'gmail.com')];
  for (const provider of ['outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'live.com', 'aol.com']) caught.push(j('a', '@', provider));
  for (const text of caught) assert.ok(hit(text), text);
  for (const text of ['https://www.bfs.admin.ch/bfs/en/home/statistics/earnings.html', 'src/components/home/Dashboard.tsx', 'someone@example.test', 'a@company.example', 'C:\\Windows\\system32']) assert.ok(!hit(text), text);
  assert.deepEqual(identifierProblems('bin', j('a\0 C', ':', '/Users', '/someone')), [], 'a binary file is not text');
});

test('a Ported-from header names a file of the old tree and a range inside it; a src file needs a header or an allow-file line; a dependency needs a budget line and may not be a metered client', () => {
  const old = { commit: 'abcdef0123456789', lines: { 'src/a.ts': 50 } };
  assert.deepEqual(headerRangeProblems('src/x.ts', '// Ported from old_repo/src/a.ts (lines 1-50)\n', old), []);
  assert.match(headerRangeProblems('src/x.ts', '// Ported from old_repo/src/a.ts (lines 40-60)\n', old).join('|'), /range 40-60 outside 1-50/);
  assert.match(headerRangeProblems('src/x.ts', '// Ported from old_repo/src/nope.ts (lines 1-2)\n', old).join('|'), /not in the old tree/);
  assert.match(headerRangeProblems('src/x.ts', '// Ported from old_repo/ broken\n', old).join('|'), /malformed/);
  assert.deepEqual(sourceOriginProblems('src/x.ts', '// Ported from old_repo/src/a.ts (lines 1-5)\n', new Map()), []);
  assert.deepEqual(sourceOriginProblems('src/new.ts', 'export const a = 1;\n', new Map([['src/new.ts', 'new in a slice']])), []);
  assert.match(sourceOriginProblems('src/new.ts', 'export const a = 1;\n', new Map()).join('|'), /no "\/\/ Ported from" header/);
  assert.match(dependencyProblems({ dependencies: { openai: '1' }, budget: { openai: 'x' } }).join('|'), /banned dependency openai/);
  assert.match(dependencyProblems({ dependencies: { zod: '1' }, budget: {} }).join('|'), /zod has no budget line/);
  assert.deepEqual(dependencyProblems({ dependencies: { zod: '1' }, budget: { zod: 'why' } }), []);
});

// ---- loc ----
test('R4: the LOC limits are compared against the real totals (the keys were backslash paths on Windows, so "src/core" never matched and nothing was compared)', () => {
  const root = tmp('loc-');
  const prev = process.cwd();
  put(root, 'src/core/a.ts', 'export const a = 1;\n// a comment\n\n/* block\n   comment */\nexport const b = 2;\n');
  put(root, 'src/app/b.tsx', 'export const c = 3;\n');
  try {
    process.chdir(root);
    const totals = totalsOf('src');
    assert.deepEqual([...totals.keys()].sort(), ['src', 'src/app', 'src/core']);
    assert.ok([...totals.keys()].every((k) => !k.includes('\\')), 'posix keys on every platform');
    assert.deepEqual([totals.get('src'), totals.get('src/core'), totals.get('src/app')], [3, 2, 1]);
    assert.deepEqual(limitProblems(totals, { 'src/core': 2, src: 3 }), []);
    assert.deepEqual(limitProblems(totals, { 'src/core': 1, src: 2 }), ['src/core has 2 code lines, limit 1', 'src has 3 code lines, limit 2']);
    assert.match(limitProblems(totals, { 'src/missing': 5 }).join('|'), /src\/missing has no code lines at all: the limit 5 compared nothing/);
  } finally {
    process.chdir(prev);
  }
  assert.equal(codeLines('a\r\n// c\r\n\r\nb'), 2, 'CRLF');
});

test('the loc script exits 1 on a tree over its limit and prints the offending directory', () => {
  const root = tmp('loc-cli-');
  put(root, 'src/core/big.ts', `${Array.from({ length: 25001 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`);
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/ci/loc.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /src\/core has 25001 code lines, limit 25000/);
});

// ---- workflow-yaml ----
test('a workflow with an unknown `needs`, a bad expression, an unknown context or a YAML error is a problem (the gate parsed YAML syntax only)', async () => {
  const lint = await createLinter();
  const good = 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.event_name }}\n  b:\n    needs: [a]\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
  assert.deepEqual(await textProblems('w.yml', good, lint), []);
  assert.match((await textProblems('w.yml', good.replace('needs: [a]', 'needs: [zzz]'), lint)).join('|'), /needs job "zzz" which does not exist/);
  assert.match((await textProblems('w.yml', good.replace('github.event_name', 'github.event_nam'), lint)).join('|'), /event_nam/);
  assert.match((await textProblems('w.yml', good.replace('github.event_name', 'githb.event_name'), lint)).join('|'), /undefined variable "githb"/);
  assert.match((await textProblems('w.yml', `${good}  c: [\n`, lint)).join('|'), /w\.yml:/);
});

// ---- edge-bundle ----
test('IMP-029: the bundle must EXPORT what the source exports and DECLARE what the worker takes from the policy and the PDF reader; a name in a comment or a string satisfies neither', () => {
  const processSource = 'export type T = 1;\nexport function isServiceRoleRequest() {}\nexport async function processRow() {}\nexport async function drain() {}\nexport const x = 1;\n';
  assert.deepEqual(sourceExports(processSource), ['drain', 'isServiceRoleRequest', 'processRow', 'x']);
  assert.deepEqual(bundleExports('function a() {}\nexport {\n  drain,\n  isServiceRoleRequest,\n  processRow as processRow,\n  x\n};\n'), ['drain', 'isServiceRoleRequest', 'processRow', 'x']);
  const entry = 'async function fetchDocument() {}\nfunction storageMaxChars() {}\nfunction isServiceRoleRequest() {}\nasync function extractText$1() {}\nDeno.serve(async () => {});\n';
  const proc = 'export {\n  drain,\n  isServiceRoleRequest,\n  processRow,\n  x\n};\n';
  assert.deepEqual(bundleProblems({ entry, process: proc, processSource }), []);
  assert.match(bundleProblems({ entry, process: proc.replace('  x\n', ''), processSource }).join('|'), /exports \[drain,isServiceRoleRequest,processRow\] where its source exports \[drain,isServiceRoleRequest,processRow,x\]/);
  const commented = '// fetchDocument storageMaxChars isServiceRoleRequest extractText\nconst note = "fetchDocument";\nDeno.serve(async () => {});\n';
  assert.equal(bundleProblems({ entry: commented, process: proc, processSource }).length, 4, 'four names are not declared');
  assert.ok(declaredNames(entry).has('extractText'), 'the bundler suffix is stripped');
  assert.match(bundleProblems({ entry: entry.replace('Deno.serve(', 'serve('), process: proc, processSource }).join('|'), /never calls Deno\.serve/);
});

// ---- changes ----
test('the scope of a change: a push or a dispatch needs everything; a pull request needs what it touches (anything the build reads for the parity job, scripts/ and tests/ for Windows)', () => {
  assert.deepEqual(scopeOf([], 'push'), { parity: true, windows: true });
  assert.deepEqual(scopeOf(['docs/x.md'], 'pull_request'), { parity: false, windows: false });
  assert.equal(scopeOf(['src/core/shared/x.ts'], 'pull_request').parity, true, 'a change to src/core can change what every page renders');
  for (const f of ['package-lock.json', 'next.config.ts', 'tests/_support/memdb.ts', 'supabase/schema.sql', 'public/x.png', '.github/workflows/ci.yml']) assert.equal(scopeOf([f], 'pull_request').parity, true, f);
  assert.equal(scopeOf(['scripts/ci/loc.mjs'], 'pull_request').windows, true);
  assert.equal(scopeOf(['tests/ci/x.test.mjs'], 'pull_request').windows, true);
  assert.equal(scopeOf(['docs/a.md'], 'pull_request').windows, false);
});

// ---- gates ----
test('every step of `npm run gates` is a real npm script, so a failure line names it (it printed `npm run undefined` for a function step)', () => {
  const scripts = JSON.parse(spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./package.json").scripts))'], { encoding: 'utf8' }).stdout);
  for (const step of STEPS) assert.ok(scripts[step.cmd], `${step.name}: ${step.cmd}`);
  assert.deepEqual(STEPS.filter((s) => s.fn), []);
});
