// R1a's share of the mutants registry (the registry itself is checked by `npm run mutants:check`): every UI check rule has its own planted-violation mutant, and the five violations of R3 are one mutant.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const registry = JSON.parse(readFileSync(new URL('./registry.json', import.meta.url), 'utf8'));

test('every UI check rule has a planted-violation mutant on the ui-checks gate', () => {
  const rules = spawnSync(process.execPath, ['scripts/ci/ui-checks.mjs', '--list-rules'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(rules.length >= 20);
  for (const rule of rules) {
    const m = registry.find((e) => e.id === `ui-checks-${rule}`);
    assert.ok(m, `rule ${rule} has no planted-violation mutant (ui-checks-${rule})`);
    assert.equal(m.gate, 'ui-checks');
  }
  assert.ok(registry.some((e) => e.id === 'ui-checks-r3-five-violations'), 'the five violations of R3 are one mutant');
});
