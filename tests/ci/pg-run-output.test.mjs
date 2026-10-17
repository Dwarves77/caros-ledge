// The class behind the red schema job of PR 27: a CI child prints a large result to a PIPED stdout and ends. Ending with process.exit() cut the output on Linux (asynchronous pipe writes); awaiting
// the drain first delivers every line. The child below ends exactly as scripts/ci/pg-run.mjs does, with a payload over 1 MB, and the parent asserts the LAST line arrives intact.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const DRAIN = new URL('../../scripts/ci/stdout-drain.mjs', import.meta.url).href;
const child = (end) => `
  import { drained } from ${JSON.stringify(DRAIN)};
  const NL = String.fromCharCode(10);
  for (let i = 0; i < 40000; i += 1) process.stdout.write('policy|table_' + i + '.policy|' + 'x'.repeat(40) + NL);
  process.stdout.write('LAST|line|intact' + NL);
  ${end}
`;
const run = (end) => spawnSync(process.execPath, ['--input-type=module', '-e', child(end)], { encoding: 'utf8', maxBuffer: 1 << 28 });

test('a payload over 1 MB written to a piped stdout arrives whole when the process ends the way pg-run does', () => {
  const r = run("await drained(process.stdout); process.exitCode = 0;");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length > 1_000_000, `the payload is over 1 MB (${r.stdout.length})`);
  assert.ok(r.stdout.endsWith('LAST|line|intact\n'), 'the last line arrived intact');
  assert.equal(r.stdout.split('\n').length - 1, 40001, 'every line arrived');
});

test('pg-run ends by awaiting the stdout drain and never calls process.exit()', () => {
  const src = readFileSync(new URL('../../scripts/ci/pg-run.mjs', import.meta.url), 'utf8');
  assert.match(src, /await drained\(process\.stdout\)/);
  assert.doesNotMatch(src, /process\.exit\(/);
});
