// RUNS-FIX-2: two pushes to main that each carry a plan run their ruled-runs jobs side by side (one group per commit, so none is dropped), and the in-flight guard of the apply rightly refuses the later one while the earlier is still applying
// (P58: operations-23 and research-30 failed against the live immediate-20 apply). The later job therefore waits for every earlier ruled-runs job on main to conclude before it starts its plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r', '');
const job = yml.slice(yml.indexOf('\n  ruled-runs:\n'), yml.indexOf('\n  visible:\n'));

test('RUNS-FIX-2: ruled-runs waits for earlier ruled-runs jobs before its plans, never cancels, and may read the run list', () => {
  const wait = job.indexOf('Wait for earlier ruled-runs');
  const run = job.indexOf('Run the plans in order');
  assert.ok(wait > 0 && wait < run, 'the wait step comes before the plans step');
  assert.match(job, /cancel-in-progress: false/);
  assert.match(job, /group: ruled-runs-\$\{\{ github\.sha \}\}/, 'the per-commit group stays: a shared group would drop a pending plan');
  assert.match(job, /permissions:\n\s+contents: read\n\s+actions: read/);
  assert.match(job, /timeout-minutes: 120/);
  assert.match(job, /\.id < \$GITHUB_RUN_ID|id < \$\{GITHUB_RUN_ID\}/, 'only EARLIER runs are waited on, so two waiters can never wait on each other');
});
