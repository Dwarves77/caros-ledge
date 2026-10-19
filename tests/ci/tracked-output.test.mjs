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

test('a workflow with a bare colon in a step name fails to parse; a valid one passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  mkdirSync(dir, { recursive: true });
  const workflow = (stepName) => ['on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', `      - name: ${stepName}`, '        run: echo ok', ''].join('\n');
  writeFileSync(join(dir, 'ok.yml'), workflow('Gates (one list)'));
  assert.deepEqual(await workflowProblems(dir), []);
  writeFileSync(join(dir, 'bad.yml'), workflow('Gates (x: y)'));
  const problems = await workflowProblems(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bad\.yml/);
});
