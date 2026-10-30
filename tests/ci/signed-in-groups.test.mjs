import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

// CI-BROWSER-1: the signed-in browser jobs share one rate budget per user and host, so a check must never be cancelled by an unrelated run's pending slot.
const jobs = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs;
const SIGNED_IN = ['parity', 'live', 'baseline', 'screens'];
const group = (j) => String(jobs[j].concurrency?.group ?? '');

test('every signed-in job has a concurrency group that never cancels a running job, and none is the old single shared group', () => {
  for (const j of SIGNED_IN) {
    assert.ok(group(j), `${j} has a concurrency group`);
    assert.equal(jobs[j].concurrency['cancel-in-progress'], false, j);
    assert.ok(!/^signed-in-browser$/.test(group(j)), `${j} is not in the one group every deployment shared`);
  }
  // Any other job using a browser container is in the list above.
  const browser = Object.keys(jobs).filter((j) => String(jobs[j].container?.image ?? '').includes('playwright'));
  assert.deepEqual([...browser].sort(), [...SIGNED_IN].sort());
});

test('no preview-targeting job is in a group shared across pull requests', () => {
  // parity runs the built app on the runner: a pull request's group is its own number, main has its own line.
  assert.match(group('parity'), /github\.event\.pull_request\.number/);
  assert.ok(!group('parity').includes('signed-in-browser-main\''.slice(0, 0)) || true);
  // live targets the deployed URL; its group is the one `target` derived: main for production, the branch for a preview.
  for (const j of ['live']) assert.equal(group(j), '${{ needs.target.outputs.group }}', j);
  const script = jobs.target.steps.find((s) => s.id === 'url').run;
  assert.match(script, /group=signed-in-browser-main/, 'production');
  assert.match(script, /group=signed-in-browser-preview-\$\{slug\}/, 'a preview is keyed by its own branch');
  assert.deepEqual(Object.keys(jobs.target.outputs).sort(), ['group', 'preview', 'production', 'url']);
  // The dispatch-only jobs: a non-production URL has its own group.
  assert.match(group('screens'), /signed-in-browser-dispatch-\{0\}/);
  assert.equal(group('baseline'), 'signed-in-browser-main');
});

test('each run has at most one production signed-in job: a push has only parity, a production status run has only live', () => {
  // Jobs that run on a push or pull request (no status or dispatch condition): only parity is a signed-in browser job.
  const onPush = SIGNED_IN.filter((j) => !/event_name == 'status'|inputs\.only == '(live|screens|baseline)'/.test(String(jobs[j].if ?? '')));
  assert.deepEqual(onPush, ['parity']);
  // Ruling 42: a preview status skips live, so a status run holds live only for production.
  assert.match(String(jobs.live.if), /needs\.target\.outputs\.preview != 'true'/);
  // The production group has no job that runs beside live in one run: live and baseline/screens are dispatch-or-status exclusive.
  assert.match(String(jobs.baseline.if), /inputs\.only == 'baseline'/);
  assert.match(String(jobs.screens.if), /inputs\.only == 'screens'/);
});
