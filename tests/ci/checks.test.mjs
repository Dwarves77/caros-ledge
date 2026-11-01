// G8: the tree, LOC, workflow, edge-bundle, scope and gate-list checks each go red on a planted violation. R1 and R4 of the 2026-10-19 audit (a package.json without its `prepare` script read "clean"; the LOC limits were never compared on
// the machine that runs the pre-push hook) are the first two cases and fail on the code as it was.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { createLinter } from 'actionlint';

import { bundleExports, bundleProblems, declaredNames, sourceExports } from '../../scripts/ci/edge-bundle.mjs';
import { codeLines, LIMITS, limitProblems, totalsOf } from '../../scripts/ci/loc.mjs';
import { scopeOf } from '../../scripts/ci/changes.mjs';
import { PROFILES, STEPS, exitVerdict, memoSkip, profileFrom, stepsFor, testFilesFor } from '../../scripts/ci/gates.mjs';
import { dependencyProblems, engineDataFiles, engineDataPins, engineDataProblems, frozenAllowProblems, headerRangeProblems, identifierProblems, NEW_FILES_FROZEN, OVERRIDE_MARKER, pushGateProblems, sourceOriginProblems } from '../../scripts/ci/tree-checks.mjs';
import { textProblems } from '../../scripts/ci/workflow-yaml.mjs';

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---- tree-checks ----
test('LOCK-NO-BLOAT-1: the new-files allowlist is frozen: a new file or a new entry is a problem that names the override marker, and a file carrying the marker is outside the pins', () => {
  const at = (files, entries) => new Map(Array.from({ length: files }, (_, i) => [`f${i}.txt`, i === 0 ? ['# header', ...Array(entries).fill('src/a.ts | r'), ''].join('\n') : '']));
  const pins = { files: 3, entries: 2 };
  assert.deepEqual(frozenAllowProblems(at(3, 2), pins), []);
  assert.match(frozenAllowProblems(at(4, 2), pins).join('|'), /4 allowlist files, pinned at 3.*OPERATOR-OVERRIDE/);
  assert.match(frozenAllowProblems(at(3, 3), pins).join('|'), /3 entries, pinned at 2.*OPERATOR-OVERRIDE/);
  const over = at(3, 2);
  over.set('new.txt', `${OVERRIDE_MARKER} the operator's ruling of the day
src/new.ts | new
src/new2.ts | new
`);
  assert.deepEqual(frozenAllowProblems(over, pins), [], 'a file with the marker and a ruling is outside the pins');
  over.set('new.txt', `${OVERRIDE_MARKER}
src/new.ts | new
`);
  assert.notDeepEqual(frozenAllowProblems(over, pins), [], 'a marker with no ruling text is no override');
  const live = new Map(readdirSync('scripts/ci/new-files').filter((n) => n.endsWith('.txt')).map((n) => [n, readFileSync(`scripts/ci/new-files/${n}`, 'utf8')]));
  assert.deepEqual(frozenAllowProblems(live), [], 'the repository is at or under its pins');
  assert.ok(NEW_FILES_FROZEN.files > 0 && NEW_FILES_FROZEN.entries > 0);
});

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
test('WORDGATE-1: engine data files are pinned by top-level key and by token shape (ADR-053); the current tree passes, and a planted trigger array, a word in a token array, or an unpinned file fails', () => {
  const pins = engineDataPins();
  const tree = engineDataFiles();
  assert.ok(tree.size >= 19 && tree.has('src/core/fetch/data/document-date.json'), 'the glob found the engine data files');
  assert.deepEqual(engineDataProblems(tree, pins), [], 'the current tree is pinned');
  const plant = (file, change) => {
    const t = new Map([...tree].map(([k, v]) => [k, structuredClone(v)]));
    change(t.get(file));
    return engineDataProblems(t, pins).join('|');
  };
  const dd = 'src/core/fetch/data/document-date.json';
  // an English trigger array re-entering a data file
  assert.match(plant(dd, (j) => { j.labels = ['Date:']; }), /document-date\.json: key labels is not pinned; an engine data file carries formal codes and numbers, never trigger words \(ADR-053\)/);
  assert.match(plant(dd, (j) => { j.signatures = ['Done at']; }), /key signatures is not pinned/);
  // a pinned key removed is a change to the pin, not a silent drop
  assert.match(plant(dd, (j) => { delete j.gapChars; }), /key gapChars is pinned but missing/);
  // a token that is not code-shaped
  assert.match(plant(dd, (j) => { j.metadata.push('Done at'); }), /metadata\[3\] "Done at" does not match/);
  assert.match(plant(dd, (j) => { j.metadata.push('dc:date published'); }), /metadata\[3\]/);
  assert.match(plant(dd, (j) => { j.metadata = 'dc:date'; }), /metadata must be an array of strings/);
  assert.deepEqual(engineDataProblems(new Map([[dd, { version: 'x', gapChars: 1, metadata: ['dc:date', 'article:published_time', 'a-b:c.d_e'] }]]), { keys: { [dd]: ['gapChars', 'metadata', 'version'] }, shapes: pins.shapes }), []);
  // an unpinned new data file, at any depth under data/, in any engine directory
  for (const f of ['src/core/parse/data/new-words.json', 'src/features/obligations/derive/data/sub/x.json', 'src/core/obligations/data/y.json']) {
    const t = new Map(tree).set(f, { a: 1 });
    assert.match(engineDataProblems(t, pins).join('|'), new RegExp(`${f.replaceAll('.', '\\.')}: file is not pinned`));
  }
  // a pinned file that left the tree is a stale pin
  const gone = new Map(tree);
  gone.delete(dd);
  assert.match(engineDataProblems(gone, pins).join('|'), /document-date\.json: pinned file is not in the tree/);
});

test('WORDGATE-1b: array-of-object entries are pinned by exact key set and per-field grammar (sanction-classes: label + token ^[a-z_]+$); the real file passes, and an extra key, a missing key, or a malformed token fails', () => {
  const pins = engineDataPins();
  const tree = engineDataFiles();
  const sc = 'src/features/obligations/derive/data/sanction-classes.json';
  assert.deepEqual(pins.entries?.[sc]?.classes?.keys, ['label', 'token'], 'the entry-shape spec pins classes to label and token');
  assert.equal(pins.entries[sc].classes.fields.token.pattern, '^[a-z_]+$');
  assert.deepEqual(engineDataProblems(tree, pins), [], 'the real sanction-classes.json passes');
  const plant = (change) => {
    const t = new Map([...tree].map(([k, v]) => [k, structuredClone(v)]));
    change(t.get(sc));
    return engineDataProblems(t, pins).join('|');
  };
  assert.match(plant((j) => { j.classes[0].synonyms = 1; }), /classes\[0\] has key synonyms outside the pinned entry keys/);
  assert.match(plant((j) => { delete j.classes[1].label; }), /classes\[1\] is missing pinned entry key label/);
  assert.match(plant((j) => { j.classes[2].token = 'Monetary_Fixed'; }), /classes\[2\]\.token "Monetary_Fixed" does not match \/\^\[a-z_\]\+\$\//);
  assert.match(plant((j) => { j.classes[2].token = 'two words'; }), /classes\[2\]\.token "two words" does not match/);
  assert.match(plant((j) => { j.classes[3] = 'monetary_fixed'; }), /classes\[3\] must be an object/);
  assert.match(plant((j) => { j.classes = 'x'; }), /classes must be an array of objects/);
});

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
  put(root, 'src/core/big.ts', `${Array.from({ length: LIMITS['src/core'] + 1 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`);
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/ci/loc.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`src/core has ${LIMITS['src/core'] + 1} code lines, limit ${LIMITS['src/core']}`));
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
  assert.deepEqual(scopeOf([], 'push'), { parity: true, edge: false });
  assert.deepEqual(scopeOf(['docs/x.md'], 'pull_request'), { parity: false, edge: false });
  assert.equal(scopeOf(['src/core/shared/x.ts'], 'pull_request').parity, true, 'a change to src/core can change what every page renders');
  for (const f of ['package-lock.json', 'next.config.ts', 'tests/_support/memdb.ts', 'supabase/schema.sql', 'public/x.png', '.github/workflows/ci.yml']) assert.equal(scopeOf([f], 'pull_request').parity, true, f);
  assert.equal('windows' in scopeOf(['scripts/ci/loc.mjs'], 'pull_request'), false, 'ci-windows is a dispatch, not a scope');
  for (const f of ['supabase/functions/capture-worker/index.ts', 'src/core/fetch/safe-fetch.ts']) assert.equal(scopeOf([f], 'push').edge, true, f);
  assert.equal(scopeOf(['supabase/schema.sql', 'src/core/db/x.ts', 'docs/a.md'], 'push').edge, false, 'a push that changed no function skips the deploy');
  for (const event of ['pull_request', 'workflow_dispatch']) assert.equal(scopeOf(['supabase/functions/capture-worker/index.ts'], event).edge, false, `${event} never deploys`);
});

// ---- gates ----
test('every step of `npm run gates` is a real npm script, so a failure line names it (it printed `npm run undefined` for a function step)', () => {
  const scripts = JSON.parse(spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./package.json").scripts))'], { encoding: 'utf8' }).stdout);
  for (const step of STEPS) assert.ok(scripts[step.cmd], `${step.name}: ${step.cmd}`);
  assert.deepEqual(STEPS.filter((s) => s.fn), []);
});

// ---- gate profiles (GATES-FAST-1) ----
test('the fast profile is a strict subset of full; build, the test suite and schema:local are full-only, the client walk is in both; full is every step', () => {
  const full = stepsFor('full').map((s) => s.cmd);
  const fast = stepsFor('fast').map((s) => s.cmd);
  assert.deepEqual(full, STEPS.map((s) => s.cmd));
  assert.ok(fast.length > 0 && fast.length < full.length, 'strict subset');
  for (const cmd of fast) assert.ok(full.includes(cmd), cmd);
  assert.deepEqual(fast, full.filter((c) => fast.includes(c)), 'fast keeps the full order');
  for (const cmd of ['build', 'test', 'schema:local']) assert.ok(!fast.includes(cmd), `${cmd} is full-only`);
  assert.ok(fast.includes('client-walk'), 'GATES-FIX-1: the client bundle walk (under 10 s) runs in the fast profile');
  assert.deepEqual(stepsFor('fast').filter((s) => s.heavy), [], 'no heavy step in fast: the hook never builds or runs the whole suite');
  assert.ok(STEPS.filter((s) => s.heavy).every((s) => !s.fast));
  assert.throws(() => stepsFor('quick'), /unknown gates profile/);
});

test('--profile is read from argv in both spellings, defaults to full, and refuses anything else', () => {
  assert.deepEqual(PROFILES, ['fast', 'full']);
  assert.equal(profileFrom([]), 'full');
  assert.equal(profileFrom(['--profile', 'fast']), 'fast');
  assert.equal(profileFrom(['--profile=full']), 'full');
  assert.throws(() => profileFrom(['--profile']), /unknown gates profile/);
  assert.throws(() => profileFrom(['--profile=quick']), /unknown gates profile/);
});

test('GATES-FIX-1: the pre-push hook runs the fast profile with the memo and the pushed ranges, never the full profile; ci.yml runs the full one explicitly', async () => {
  const read = (rel) => readFileSync(rel, 'utf8');
  const hook = read('.githooks/pre-push');
  assert.match(hook, /exec node scripts\/ci\/gates\.mjs --memo --profile fast \$ranges/);
  assert.doesNotMatch(hook.replace(/^#.*$/gm, ''), /--profile full|--profile=full/, 'the hook never selects full');
  assert.match(hook, /\[skip ci\]/, 'the [skip ci] refusal stays');
  assert.match(read('.github/workflows/ci.yml'), /run: npm run gates -- --profile full\s*$/m);
  const gates = await import('../../scripts/ci/gates.mjs');
  for (const gone of ['pickProfile', 'fullTrigger', 'FULL_PREFIXES', 'FULL_FILES']) assert.ok(!(gone in gates), `${gone} (the HOOK-FULL-1 selection) is removed`);
});

test('GATES-FIX-1: the changed paths of a push map to the test files that cover them', () => {
  const tracked = ['tests/ci/a.test.mjs', 'tests/ci/b.test.ts', 'tests/ci/_helper.mjs', 'tests/urgency/u.test.ts', 'tests/core/urgency/c.test.ts', 'tests/core/auth.test.ts', 'tests/core/authz/x.test.ts', 'tests/dashboard/d.test.ts', 'tests/lists/l.test.ts', 'tests/misc/m.test.ts'];
  const of = (...files) => testFilesFor(files, tracked);
  assert.deepEqual(of('src/core/urgency/score.ts'), ['tests/core/urgency/c.test.ts', 'tests/urgency/u.test.ts'], 'src/core/<x> -> tests/<x> and tests/core/<x>');
  assert.deepEqual(of('src/core/auth/guard.ts'), ['tests/core/auth.test.ts'], 'src/core/<x> -> tests/core/<x>.test.*, and not tests/core/authz');
  assert.deepEqual(of('src/features/dashboard/Row.tsx'), ['tests/dashboard/d.test.ts'], 'src/features/<x> -> tests/<x>');
  assert.deepEqual(of('scripts/ci/gates.mjs'), ['tests/ci/a.test.mjs', 'tests/ci/b.test.ts'], 'scripts/ci -> tests/ci (test files only)');
  assert.deepEqual(of('tests/misc/m.test.ts'), ['tests/misc/m.test.ts'], 'a changed test file runs itself');
  assert.deepEqual(of('tests/misc/deleted.test.ts', 'tests/ci/_helper.mjs'), [], 'a deleted test file and a non-test helper select nothing');
  assert.deepEqual(of('src/core/urgency/a.ts', 'src/core/urgency/b.ts', 'tests/urgency/u.test.ts'), ['tests/core/urgency/c.test.ts', 'tests/urgency/u.test.ts'], 'de-duplicated, sorted');
  assert.deepEqual(of('docs/a.md', 'supabase/migrations/0001.sql', 'src/app/page.tsx', 'package.json'), [], 'migrations are the schema:local step; docs and uncovered src select no test');
});

const rec = { sha: 'a'.repeat(40), tree: 'c'.repeat(40), profile: 'fast', at: '2026-10-31T10:00:00.000Z', seconds: 90, targeted: true };
const ctx = { head: 'a'.repeat(40), tree: 'c'.repeat(40), profile: 'fast', clean: true, ci: false, targeted: true };
test('GATES-FIX-1: a recorded pass is skipped only for the same HEAD, a covering profile, a clean tree, outside CI', () => {
  assert.match(memoSkip(rec, ctx), /^gates: HEAD aaaaaaaaaaaa already passed fast at 2026-10-31T10:00:00\.000Z; skipping \(memo: tree cccccccccccc\)$/);
  assert.ok(memoSkip({ ...rec, profile: 'full' }, ctx), 'full covers fast');
  assert.equal(memoSkip(rec, { ...ctx, clean: false }), null, 'dirty tree');
  assert.equal(memoSkip(rec, { ...ctx, head: 'b'.repeat(40) }), null, 'different sha');
  assert.equal(memoSkip(rec, { ...ctx, profile: 'full' }), null, 'fast does not cover full');
  assert.equal(memoSkip(rec, { ...ctx, ci: true }), null, 'CI never skips');
  assert.equal(memoSkip({ ...rec, targeted: false }, ctx), null, "a pass that did not run the changed modules' tests does not cover a push that must");
  assert.ok(memoSkip({ ...rec, targeted: false }, { ...ctx, targeted: false }));
  assert.equal(memoSkip(null, ctx), null, 'no record');
});

test('GATES-FIX-1: gates.mjs records a pass in the git-dir on a clean tree and skips under --memo until the tree or HEAD changes (run as a program in a throwaway repo)', () => {
  const repo = tmp('gates-memo-');
  const script = resolve('scripts/ci/gates.mjs');
  const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env } });
  const gates = (args, env) => sh(process.execPath, [script, ...args], env);
  // every script passes, except the first step, which fails when GATES_T_FAIL is set: a run that was not skipped is a red one-second run, so only two runs here go through every step
  const scripts = Object.fromEntries([...stepsFor('fast').map((s) => s.cmd), 'schema:local'].map((c) => [c, 'node -e 0']));
  scripts[stepsFor('fast')[0].cmd] = 'node -e "process.exit(process.env.GATES_T_FAIL ? 1 : 0)"';
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts }));
  const commit = (...extra) => sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', ...extra]);
  assert.equal(sh('git', ['init', '-q']).status, 0);
  assert.equal(sh('git', ['add', '.']).status, 0);
  assert.equal(commit('-m', 'one').status, 0);
  const head = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  const file = join(repo, '.git', 'gates-last-pass.json');
  const ran = (r) => r.stdout.includes('== ');
  const FAIL = { GATES_T_FAIL: '1' };

  const first = gates(['--profile', 'fast']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const recorded = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([recorded.sha, recorded.profile, recorded.targeted], [head, 'fast', false]);

  const skipped = gates(['--memo', '--profile', 'fast']);
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /^gates: HEAD [0-9a-f]{12} already passed fast at /);
  assert.ok(!ran(skipped), 'no step ran');
  assert.ok(ran(gates(['--profile', 'fast'], FAIL)), 'without --memo it always runs');
  assert.ok(ran(gates(['--memo', '--profile', 'fast'], { ...FAIL, CI: 'true' })), 'CI never skips');
  assert.ok(ran(gates(['--memo', '--profile', 'fast', '--range', 'HEAD..HEAD'], FAIL)), 'a pass without the changed-module tests does not cover the hook');

  writeFileSync(join(repo, 'dirty.txt'), 'x');
  assert.ok(ran(gates(['--memo', '--profile', 'fast'])), 'a dirty tree runs');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sha, head, 'and, passing, records nothing: the tree is not the commit');
  rmSync(join(repo, 'dirty.txt'));
  assert.equal(commit('--allow-empty', '-m', 'two').status, 0);
  assert.ok(ran(gates(['--memo', '--profile', 'fast'], FAIL)), 'a new HEAD runs');
});

test('GATES-FIX-2: a memo is keyed on the tree as well as the commit; the line names the tree it keyed on', () => {
  assert.equal(memoSkip(rec, { ...ctx, tree: 'd'.repeat(40) }), null, 'same HEAD sha but a different tree hash runs');
  assert.match(memoSkip(rec, ctx), /\(memo: tree cccccccccccc\)$/);
});

test('GATES-FIX-2: exit 2 is a skip only for a credential-gated (mayskip) step outside CI; tsc exits 2 on a type error, which is a failure', () => {
  const typecheck = STEPS.find((s) => s.cmd === 'typecheck');
  assert.ok(!typecheck.mayskip);
  assert.equal(exitVerdict(typecheck, 2, false), 'fail', 'tsc --noEmit exit 2 (diagnostics present) is red, not skipped');
  assert.equal(exitVerdict(typecheck, 1, false), 'fail');
  assert.equal(exitVerdict(typecheck, 0, false), 'pass');
  const gated = STEPS.find((s) => s.cmd === 'joinability');
  assert.equal(exitVerdict(gated, 2, false), 'skip');
  assert.equal(exitVerdict(gated, 2, true), 'fail', 'CI never skips');
  assert.deepEqual(STEPS.filter((s) => s.mayskip).map((s) => s.cmd), ['joinability'], 'only the credential-gated check opts in');
});

test('GATES-FIX-2: run as a program, a planted type error (typecheck exits 2) fails the fast profile even with a fresh memo entry; an unchanged tree skips', () => {
  const repo = tmp('gates-tc-');
  const script = resolve('scripts/ci/gates.mjs');
  const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env } });
  const scripts = Object.fromEntries(stepsFor('fast').map((s) => [s.cmd, 'node -e 0']));
  scripts.typecheck = 'node -e "process.exit(require(\'fs\').existsSync(\'bad.test.ts\') ? 2 : 0)"';
  scripts.joinability = 'node -e "process.exit(2)"';
  scripts['schema:local'] = 'node -e 0';
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts }));
  const commit = (...extra) => sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', ...extra]);
  assert.equal(sh('git', ['init', '-q']).status, 0);
  assert.equal(sh('git', ['add', '.']).status, 0);
  assert.equal(commit('-m', 'one').status, 0);
  const gates = (args) => sh(process.execPath, [script, ...args]);
  const first = gates(['--memo', '--profile', 'fast']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /1 skipped \(joinability: exit 2/);
  assert.ok(!/skipped \([^)]*typecheck/.test(first.stdout));
  const again = gates(['--memo', '--profile', 'fast']);
  assert.match(again.stdout, /already passed fast .*memo: tree [0-9a-f]{12}\)/);
  assert.ok(!again.stdout.includes('== '), 'unchanged tree: no step ran');
  writeFileSync(join(repo, 'bad.test.ts'), 'x');
  assert.equal(sh('git', ['add', '.']).status, 0);
  assert.equal(commit('-m', 'two').status, 0);
  const bad = gates(['--memo', '--profile', 'fast']);
  assert.equal(bad.status, 1, 'the planted type error is red');
  assert.match(bad.stderr, /FAILED at "Typecheck"/);
});
