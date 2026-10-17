import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { trackedOutputProblems } from '../../scripts/ci/tracked-output.mjs';
import { workflowProblems } from '../../scripts/ci/workflow-yaml.mjs';

test('a tracked generated file or a tracked binary outside its home fails; the allowlisted homes pass', () => {
  const fails = trackedOutputProblems(['parity-diff/home.1280x900.png', 'test-output.txt', 'docs/shot.png', 'src/app/icon.png']);
  assert.equal(fails.length, 4);
  assert.deepEqual(trackedOutputProblems(['tests/parity/baseline/home.1280x900.png', 'public/logo.png', 'src/app/page.tsx']), []);
});

test('a workflow with a bare colon in a step name fails to parse; a valid one passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ok.yml'), 'jobs:\n  a:\n    steps:\n      - name: Gates (one list)\n        run: echo ok\n');
  assert.deepEqual(workflowProblems(dir), []);
  writeFileSync(join(dir, 'bad.yml'), 'jobs:\n  a:\n    steps:\n      - name: Gates (x: y)\n        run: echo ok\n');
  const problems = workflowProblems(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bad\.yml/);
});
