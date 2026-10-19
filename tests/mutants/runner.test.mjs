// The mutants runner and its registry rules, tried on a throwaway repository with a gate of its own: a mutant that makes the gate fail is `red` (caught), one that leaves it passing is `green` (the build fails), one that
// no longer applies is `error`; a gate with no mutant, a mutant for no gate, a duplicate id, a stale edit and a malformed entry are each a registry problem. The registry of this repository is checked against its real gate
// inventory by `npm run mutants:check` (a gate step), which tests/ci/checks.test.mjs also runs once here.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { gateInventory, classOf } from '../../scripts/ci/mutants/inventory.mjs';
import { loadRegistry, registryProblems, shapeProblems } from '../../scripts/ci/mutants/registry.mjs';
import { applyEdits, firstRedLine, gateCommand, judge } from '../../scripts/ci/mutants/run.mjs';
import { restore } from '../../scripts/ci/mutants/scratch.mjs';
import { reportTable, runOne } from '../../scripts/ci/mutants.mjs';

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutants-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('package.json', JSON.stringify({ scripts: { 'no-bad-word': 'node check.mjs' } }));
  put('check.mjs', "import { readFileSync } from 'node:fs';\nconst t = readFileSync('data.txt', 'utf8');\nif (t.includes('BAD')) { console.error('data.txt:1: contains BAD'); process.exit(1); }\nconsole.log('clean');\n");
  put('data.txt', 'good\nline two\n');
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@invalid.example'], ['config', 'core.autocrlf', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'base']]) execFileSync('git', args, { cwd: dir });
  return dir;
};
const mutant = (over) => ({ id: 'm', gate: 'no-bad-word', apply: [{ file: 'data.txt', find: 'good', replace: 'BAD' }], expect: 'red', closes: ['K:1'], ...over });

test('a mutant that makes its gate fail is red, with the gate\'s own first red line; the scratch is restored after it', () => {
  const dir = repo();
  const row = runOne(dir, mutant());
  assert.equal(row.verdict, 'red');
  assert.equal(row.line, 'data.txt:1: contains BAD');
  assert.equal(readFileSync(join(dir, 'data.txt'), 'utf8'), 'good\nline two\n', 'restored');
});

test('a mutant that leaves its gate green is reported green: that gate certifies nothing, and the build fails', () => {
  const dir = repo();
  const row = runOne(dir, mutant({ id: 'harmless', apply: [{ file: 'data.txt', find: 'line two', replace: 'line 2' }] }));
  assert.equal(row.verdict, 'green');
  assert.equal(reportTable([row], 1).includes('GREEN'), true);
});

test('a mutant whose text is no longer in the file does not apply: an error, never a pass', () => {
  const dir = repo();
  const row = runOne(dir, mutant({ apply: [{ file: 'data.txt', find: 'absent text', replace: 'x' }] }));
  assert.equal(row.verdict, 'error');
  assert.match(row.line, /did not apply: data\.txt does not contain the text/);
});

test('a script mutant runs in the scratch with its id; a gate script that CRASHES instead of reporting is an error, not a catch', () => {
  const dir = repo();
  writeFileSync(join(dir, 'plant.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('data.txt', 'BAD ' + process.env.MUTANT_ID + '\\n');\n");
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'plant'], { cwd: dir });
  const row = runOne(dir, mutant({ id: 'scripted', apply: { script: 'plant.mjs' } }));
  assert.equal(row.verdict, 'red');
  writeFileSync(join(dir, 'check.mjs'), "throw new TypeError('x is not a function');\n");
  execFileSync('git', ['commit', '-q', '-am', 'broken gate'], { cwd: dir });
  const crashed = runOne(dir, mutant({ id: 'crash' }));
  assert.equal(crashed.verdict, 'error');
  assert.match(crashed.line, /crashed instead of reporting/);
});

test('edits keep a file\'s CRLF line endings and replace the first occurrence only', () => {
  const dir = repo();
  writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo\r\none\r\n');
  applyEdits(dir, [{ file: 'crlf.txt', find: 'one\ntwo', replace: 'ONE\ntwo' }]);
  assert.equal(readFileSync(join(dir, 'crlf.txt'), 'utf8'), 'ONE\r\ntwo\r\none\r\n');
  restore(dir);
});

test('the verdict and the red line: a located problem line wins over a summary count; tool noise is skipped; a timeout is an error', () => {
  assert.equal(firstRedLine('npm error foo\n1 problem(s)\npackage.json:1: the prepare script is missing\n'), 'package.json:1: the prepare script is missing');
  assert.equal(firstRedLine('> x\n(node:1) Warning\nsomething broke: boom\n'), 'something broke: boom');
  assert.equal(judge('loc', { code: null, signal: 'SIGTERM', output: '', ms: 1, spawnError: null }).verdict, 'error');
  assert.equal(judge('lint', { code: 1, signal: null, output: 'SyntaxError: x', ms: 1, spawnError: null }).verdict, 'red', 'a syntax error is what lint and typecheck exist to report');
  assert.deepEqual(gateCommand('test', { scope: ['tests/ci/a.test.mjs'] }).args.slice(-1), ['tests/ci/a.test.mjs']);
  assert.deepEqual(gateCommand('property:rls-enabled').args, ['scripts/ci/properties.mjs', '--only', 'rls-enabled']);
});

test('the registry rules: every gate needs a mutant, every mutant a gate, ids are unique, edits must still apply, entries have the fixed shape', () => {
  const root = repo();
  const inventory = ['no-bad-word', 'second-gate', 'selfcheck:0001-a', 'selfcheck:0002-b'];
  const ok = [mutant({ id: 'a' }), mutant({ id: 'b', gate: 'second-gate', apply: { script: 'check.mjs' } }), mutant({ id: 'c', gate: 'selfcheck:*', apply: { transform: 'check.mjs' } })];
  assert.deepEqual(registryProblems(ok, inventory, root), []);
  const text = (p) => registryProblems(p, inventory, root).join('|');
  assert.match(text(ok.slice(0, 1)), /gate second-gate has no registered mutant/);
  assert.match(text([...ok, mutant({ id: 'd', gate: 'nope' })]), /d names gate nope, which is not a gate/);
  assert.match(text([...ok, mutant({ id: 'a' })]), /duplicate id a/);
  assert.match(text([...ok, mutant({ id: 'e', apply: [{ file: 'data.txt', find: 'gone', replace: 'x' }] })]), /e is stale: data\.txt no longer contains the text it replaces/);
  assert.match(text([...ok, mutant({ id: 'f', apply: [{ file: 'missing.txt', find: 'a', replace: 'b' }] })]), /edits missing\.txt, which does not exist/);
  assert.match(shapeProblems(mutant({ expect: 'green' }), 0).join('|'), /expect must be "red"/);
  assert.match(shapeProblems(mutant({ closes: [] }), 0).join('|'), /closes must list register ids/);
  assert.match(shapeProblems(mutant({ closes: ['G3'] }), 0).join('|'), /closes must list register ids/);
  assert.match(shapeProblems(mutant({ apply: [{ file: 'a', find: 'x', replace: 'x' }] }), 0).join('|'), /different from replace/);
  assert.match(shapeProblems(mutant({ apply: { transform: 'x.mjs' } }), 0).join('|'), /every gate of a kind/);
  assert.deepEqual(shapeProblems(mutant({ gate: 'selfcheck:0060-rls-attacks', apply: { transform: 'x.mjs' } }), 0), [], 'a transform may also name one migration self-check');
  assert.match(shapeProblems(mutant({ scope: ['a.test.mjs'] }), 0).join('|'), /scope narrows the gate "test"/);
  assert.match(shapeProblems(mutant({ gate: 'test', scope: ['a'], apply: [{ file: 'a', find: 'x', replace: 'y' }] }), 0).join('|'), /^$/);
});

test('THIS repository: every gate has a registered mutant that applies (npm run mutants:check), the classes are the three the workflow selects, and the registry is valid JSON in the fixed format', () => {
  const registry = loadRegistry('.');
  const inventory = gateInventory('.');
  assert.deepEqual(registryProblems(registry, inventory, '.'), []);
  assert.ok(registry.length >= 10);
  assert.deepEqual([...new Set(inventory.map(classOf))].sort(), ['fast', 'schema', 'slow']);
  const r = spawnSync(process.execPath, ['scripts/ci/mutants.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cover all \d+ gates/);
});
