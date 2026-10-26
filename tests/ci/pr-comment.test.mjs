import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The report job runs the default branch's scripts and counts the lines of the tree under report, checked out beside them as data (LOC_ROOT).
test('the code-line table of the PR comment counts the src/ of LOC_ROOT, and the working directory when it is unset', () => {
  const root = mkdtempSync(join(tmpdir(), 'loc-root-'));
  try {
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'a.ts'), '// a comment\nexport const a = 1;\n\nexport const b = 2;\n');
    const run = (env) => spawnSync(process.execPath, ['scripts/ci/pr-comment.mjs'], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DRY: '1', NEEDS: '{}', REPO: 'o/r', RUN_ID: '1', ...env }, encoding: 'utf8' });
    const other = run({ LOC_ROOT: root });
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stdout, /\| src \| 2 \|\n\| src\/core \| 2 \|/);
    const own = run({});
    assert.match(own.stdout, /\| src \| (\d{4,}) \|/, 'unset: this checkout');
    assert.doesNotMatch(own.stdout, /\| src \| 2 \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// CI-BROWSER-1: a signed-in job cancelled out of its pending slot is SUPERSEDED, never a pass and never a fail.
test('a cancelled signed-in job is labelled SUPERSEDED naming the run that took its slot; other conclusions and jobs are unchanged', async () => {
  const { conclusionLabel, supersedingRun } = await import('../../scripts/ci/pr-comment.mjs');
  assert.match(conclusionLabel('parity', 'cancelled', 42), /^SUPERSEDED by run 42 \(not a pass, not a fail\)$/);
  assert.match(conclusionLabel('live', 'cancelled', null), /^SUPERSEDED \(/);
  assert.equal(conclusionLabel('parity', 'success', 42), 'success');
  assert.equal(conclusionLabel('parity', 'failure', 42), 'failure');
  assert.equal(conclusionLabel('ci', 'cancelled', 42), 'cancelled', 'only the signed-in jobs share a pending slot');
  assert.equal(supersedingRun([{ id: 9 }, { id: 12 }, { id: 11 }, { id: 5 }], 10), 11, 'the earliest later run');
  assert.equal(supersedingRun([{ id: 5 }], 10), null);
});
