import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const jobs = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs;
// Evaluates a job's `if` for an event and the dispatch input `only` (the expressions use only ==, !=, && and || on those two values).
const runs = (job, event, only = '') => {
  const expr = String(jobs[job].if ?? 'true').replaceAll('github.event_name', 'ev').replaceAll('github.event.inputs.only', 'only').replaceAll('==', '===').replaceAll('!=', '!==');
  return Function('ev', 'only', `return (${expr});`)(event, only);
};
const on = (event, only) => Object.keys(jobs).filter((j) => j !== 'report' && runs(j, event, only)).sort();

test('a dispatch with only empty runs everything but baseline; only=baseline runs baseline alone; only=turn runs turn alone', () => {
  assert.deepEqual(on('workflow_dispatch', ''), ['ci', 'parity', 'schema', 'turn', 'windows']);
  assert.deepEqual(on('workflow_dispatch', 'baseline'), ['baseline']);
  assert.deepEqual(on('workflow_dispatch', 'turn'), ['turn']);
});

test('a pull request never runs baseline or windows; a push to main runs the checks and windows but not baseline', () => {
  assert.deepEqual(on('pull_request'), ['ci', 'parity', 'schema', 'turn']);
  assert.deepEqual(on('push'), ['ci', 'parity', 'schema', 'turn', 'windows']);
});
