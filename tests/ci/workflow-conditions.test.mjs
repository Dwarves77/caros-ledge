import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const jobs = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs;
// Evaluates a job's `if` for an event, the dispatch input `only`, and a deployment_status's state and environment (the expressions use only ==, !=, &&, || and parentheses on those values).
const runs = (job, event, only = '', status = {}) => {
  const expr = String(jobs[job].if ?? 'true')
    .replaceAll('github.event_name', 'ev')
    .replaceAll('github.event.inputs.only', 'only')
    .replaceAll('github.event.deployment_status.state', 'dstate')
    .replaceAll('github.event.deployment_status.environment', 'denv')
    .replaceAll('==', '===')
    .replaceAll('!=', '!==');
  return Function('ev', 'only', 'dstate', 'denv', `return (${expr});`)(event, only, status.state ?? '', status.environment ?? '');
};
const on = (event, only, status) => Object.keys(jobs).filter((j) => j !== 'report' && runs(j, event, only, status)).sort();

test('a dispatch with only empty runs everything but baseline and live; only=baseline runs baseline alone; only=turn runs turn alone; only=live runs the live checks and the deployed-preview parity alone', () => {
  assert.deepEqual(on('workflow_dispatch', ''), ['ci', 'parity', 'schema', 'turn', 'windows']);
  assert.deepEqual(on('workflow_dispatch', 'baseline'), ['baseline']);
  assert.deepEqual(on('workflow_dispatch', 'turn'), ['turn']);
  assert.deepEqual(on('workflow_dispatch', 'live'), ['live', 'preview-parity']);
});

test('a pull request never runs baseline, windows or the live jobs; a push to main runs the checks and windows but not baseline or the live jobs', () => {
  assert.deepEqual(on('pull_request'), ['ci', 'parity', 'schema', 'turn']);
  assert.deepEqual(on('push'), ['ci', 'parity', 'schema', 'turn', 'windows']);
});

test('a successful PREVIEW deployment runs the live checks and the deployed-preview parity and nothing else; a failed, pending or production deployment runs nothing (production is checked by a dispatch, after the window)', () => {
  assert.deepEqual(on('deployment_status', '', { state: 'success', environment: 'Preview' }), ['live', 'preview-parity']);
  for (const status of [{ state: 'failure', environment: 'Preview' }, { state: 'pending', environment: 'Preview' }, { state: 'success', environment: 'Production' }, {}]) assert.deepEqual(on('deployment_status', '', status), [], JSON.stringify(status));
  assert.match(String(jobs.report.if), /deployment_status/, 'the report job does not run for a deployment event');
});

test('the live jobs check out the DEPLOYED commit (a deployment_status event carries the default branch in GITHUB_SHA) and pass the preview URL', () => {
  for (const name of ['live', 'preview-parity']) {
    const checkout = jobs[name].steps.find((s) => String(s.uses).startsWith('actions/checkout'));
    assert.match(String(checkout.with.ref), /github\.event\.deployment\.sha/, name);
  }
  assert.match(String(jobs.live.env.LIVE_BASE_URL), /deployment_status\.environment_url/);
  assert.match(String(jobs['preview-parity'].env.PARITY_ADMIN), /secrets\.LIVE_ADMIN_EMAIL/, 'the admin capture is on only when the admin account is configured');
});

test('the turn job receives the free EIA key the market producer reads by name', () => {
  assert.match(String(jobs.turn.env.EIA_API_KEY), /secrets\.EIA_API_KEY/);
});

test('the screens job runs on a dispatch with only=screens alone; no push, pull request, deployment or other dispatch runs it', () => {
  assert.deepEqual(on('workflow_dispatch', 'screens'), ['screens']);
  for (const [event, only] of [['workflow_dispatch', ''], ['workflow_dispatch', 'live'], ['workflow_dispatch', 'baseline'], ['workflow_dispatch', 'turn'], ['pull_request', ''], ['push', '']]) {
    assert.ok(!on(event, only).includes('screens'), `${event} only=${only}`);
  }
  assert.ok(!on('deployment_status', '', { state: 'success', environment: 'Preview' }).includes('screens'));
  assert.ok(!on('workflow_dispatch', 'screens').includes('ci'), 'only=screens does not start the checks');
});

test('the screens job photographs the dispatched live_url fresh and uploads the PNGs', () => {
  assert.match(String(jobs.screens.env.SCREENS_BASE), /inputs\.live_url/);
  const run = jobs.screens.steps.map((s) => String(s.run ?? '')).join(' ');
  assert.match(run, /capture\.mjs --base "\$SCREENS_BASE" --out screens --fresh/);
  assert.ok(jobs.screens.steps.some((s) => String(s.uses).startsWith('actions/upload-artifact')));
});
