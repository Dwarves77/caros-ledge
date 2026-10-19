// The mutants registry (tests/mutants/registry.json) is data a runner trusts, so it is held to the tree: every entry is well formed, every edit's text occurs exactly once in the file it names (a mutant whose text drifted
// would apply nothing and "survive" or crash), every gate exists, and every gate-integrity class this slice closes has a mutant, including one planted violation per UI check rule. The runner (R1b) applies each mutant to a scratch
// copy, runs its gate and fails the build unless the gate goes red; until it lands each mutant was applied, run and reverted by hand and its red line recorded in the PR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const registry = JSON.parse(readFileSync(new URL('./registry.json', import.meta.url), 'utf8'));
const lf = (text) => text.replaceAll('\r\n', '\n');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const CLASS = /^(?:G\d+b?|[KSCDFW]:\d+)$/;

test('every entry is well formed: an id, a gate that exists, an expectation, the rows it closes, and edits that apply or a script that exists', () => {
  assert.ok(Array.isArray(registry) && registry.length > 0);
  const ids = new Set();
  for (const e of registry) {
    assert.match(e.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `id ${e.id}`);
    assert.ok(!ids.has(e.id), `${e.id} is listed twice`);
    ids.add(e.id);
    assert.equal(e.expect, 'red', `${e.id}: a mutant expects its gate red`);
    assert.ok(e.gate in pkg.scripts || existsSync(e.gate), `${e.id}: gate ${e.gate} is neither an npm script nor a file`);
    assert.ok(Array.isArray(e.closes) && e.closes.length > 0 && e.closes.every((c) => CLASS.test(c)), `${e.id}: closes names register rows or gate classes`);
    for (const f of e.only ?? []) assert.ok(existsSync(f), `${e.id}: only names ${f}, which does not exist`);
    if (e.script) {
      assert.ok(existsSync(e.script), `${e.id}: script ${e.script} does not exist`);
      continue;
    }
    assert.ok(Array.isArray(e.apply) && e.apply.length > 0, `${e.id}: no edits and no script`);
    for (const edit of e.apply) {
      assert.ok(existsSync(edit.file), `${e.id}: ${edit.file} does not exist`);
      const text = lf(readFileSync(edit.file, 'utf8'));
      assert.equal(text.split(edit.find).length - 1, 1, `${e.id}: the text to replace occurs ${text.split(edit.find).length - 1} times in ${edit.file}, expected once`);
      assert.notEqual(edit.find, edit.replace, `${e.id}: the edit changes nothing`);
    }
  }
});

test('every gate-integrity class this slice closes (G1, G2, G2b, G4, G5) has mutants, and every UI check rule has its own planted-violation mutant', () => {
  for (const klass of ['G1', 'G2', 'G2b', 'G4', 'G5']) assert.ok(registry.some((e) => e.closes.includes(klass)), `no mutant closes ${klass}`);
  const rules = spawnSync(process.execPath, ['scripts/ci/ui-checks.mjs', '--list-rules'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(rules.length >= 20);
  for (const rule of rules) {
    const m = registry.find((e) => e.id === `ui-checks-${rule}`);
    assert.ok(m, `rule ${rule} has no planted-violation mutant (ui-checks-${rule})`);
    assert.equal(m.gate, 'ui-checks');
  }
  assert.ok(registry.some((e) => e.id === 'ui-checks-r3-five-violations'), 'the five violations of R3 are one mutant');
});

test('a mutant that needs the app says how: needs is "app" (the built app serves the fixtures on :3100) or "build" (the mutated source is rebuilt first), and passes the smoke its --base', () => {
  for (const e of registry.filter((x) => x.needs)) {
    assert.ok(['app', 'build'].includes(e.needs), `${e.id}: needs ${e.needs}`);
    assert.deepEqual(e.args, ['--base', 'http://localhost:3100'], `${e.id}: args`);
    assert.ok(e.gate.startsWith('tests/ux/') && e.gate.endsWith('-smoke.mjs'), `${e.id}: only a smoke needs the app`);
  }
  for (const e of registry.filter((x) => x.gate.startsWith('tests/ux/') && x.gate.endsWith('-smoke.mjs'))) assert.ok(e.needs, `${e.id}: a smoke gate declares what it needs`);
});
