// G3: the four scripts that need credentials (the turn, the live checks, the generator pins, the cutover dry run) share one exit-code contract (src/core/harness/exit.ts): exit 2, a skip, only where the event cannot carry secrets;
// exit 1, with the missing names listed, everywhere a secret could have been supplied. The live checks' own cases are in tests/cutover/live-checks.test.ts; the contract's decision table is in tests/turn/harness-gates.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const bare = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
const node = (args, extra = {}) => spawnSync(process.execPath, args, { env: { ...bare, ...extra }, encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'exit-contract-'));
writeFileSync(join(dir, 'fork.json'), JSON.stringify({ pull_request: { head: { repo: { fork: true } } } }));
const FORK = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(dir, 'fork.json') };

test('generator-pins without DATABASE_URL: a workstation skips, a fork PR skips, every other CI event fails and names DATABASE_URL', () => {
  const run = (extra) => node(['--import', './tests/_support/register.mjs', 'scripts/ci/checks/generator-pins.mjs'], extra);
  assert.equal(run({}).status, 2);
  assert.equal(run(FORK).status, 2);
  for (const event of ['push', 'workflow_dispatch', 'pull_request']) {
    const r = run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: event });
    assert.equal(r.status, 1, event);
    assert.match(r.stderr, /missing \(exit 1\): DATABASE_URL/);
  }
});

test('the cutover dry run asked for with no database has not run: exit 1 on a workstation and in CI, never a skip', () => {
  for (const extra of [{}, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' }]) {
    const r = node(['scripts/cutover/dry-run.mjs'], extra);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing \(exit 1\): DATABASE_URL/);
  }
});

test('the turn CLI refuses to run on any CI event but a dispatch (exit 1, not a skip), and the workflow gives it secrets on a dispatch only', () => {
  for (const event of ['push', 'pull_request', 'status']) {
    const r = node(['scripts/turn.mjs', '--stage', 'all', '--mode', 'dry'], { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: event });
    assert.equal(r.status, 1, event);
    assert.match(r.stderr, new RegExp(`a turn runs only on a dispatch \\(this run is a ${event}\\)`));
  }
  assert.match(readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r\n', '\n'), /turn:\n    name: turn\n    if: github\.event_name == 'workflow_dispatch'/);
});

test('no script decides exit 2 for itself: three call skipVerdict and the turn takes its exit from the run frame, which does', () => {
  for (const f of ['scripts/turn.mjs', 'scripts/ci/live-checks.mjs', 'scripts/ci/checks/generator-pins.mjs', 'scripts/cutover/dry-run.mjs']) assert.doesNotMatch(readFileSync(f, 'utf8'), /process\.exit\(2\)/, f);
  for (const f of ['scripts/ci/live-checks.mjs', 'scripts/ci/checks/generator-pins.mjs', 'scripts/cutover/dry-run.mjs']) assert.match(readFileSync(f, 'utf8'), /skipVerdict/, f);
  assert.match(readFileSync('src/core/harness/run.ts', 'utf8'), /skipVerdict\(h\.env/);
});
