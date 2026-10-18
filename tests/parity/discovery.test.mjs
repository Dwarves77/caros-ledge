import assert from 'node:assert/strict';
import test from 'node:test';

import { discoveryMissOutcome, pathFor } from './capture.mjs';

const route = (list) => ({ name: 'x-detail', discover: { list, match: '^/x/[^/]+$' } });
const gates = { full: ['home', 'market'], frame: ['regulations', 'dashboard'] };

test('a discovery miss on a frame-only list route is skipped', () => {
  const out = discoveryMissOutcome(route('/regulations'), gates);
  assert.equal(out.status, 'skipped');
  assert.equal(out.error, 'discovery deferred: /regulations is frame-only (gates.frame)');
});

test('a discovery miss on a full-gated list route is an error', () => {
  assert.equal(discoveryMissOutcome(route('/market'), gates).status, 'error');
});

test('a discovery miss on an undeclared list route is an error', () => {
  assert.equal(discoveryMissOutcome(route('/community'), gates).status, 'error');
});

test('the dashboard is captured at "/" on the old site and at its own path otherwise', () => {
  const dashboard = { name: 'dashboard', path: '/dashboard', oldPath: '/' };
  assert.equal(pathFor(dashboard, 'old'), '/');
  assert.equal(pathFor(dashboard, undefined), '/dashboard');
  assert.equal(pathFor({ name: 'market', path: '/market' }, 'old'), '/market');
});

test('a miss on a route the baseline has never captured is skipped, "baseline owed", whatever the gate says', () => {
  const index = { routes: [{ name: 'x-detail', files: [] }] };
  const out = discoveryMissOutcome(route('/market'), gates, index);
  assert.deepEqual([out.status, out.error], ['skipped', 'baseline owed: x-detail not yet captured from the old site']);
  assert.equal(discoveryMissOutcome(route('/market'), gates, { routes: [] }).status, 'skipped', 'no entry at all is owed too');
});

test('once the baseline carries files for the route, a miss fails as before (the owed state retires itself)', () => {
  const index = { routes: [{ name: 'x-detail', files: ['x-detail.1280x900', 'x-detail.375x812'] }] };
  assert.equal(discoveryMissOutcome(route('/market'), gates, index).status, 'error');
  assert.equal(discoveryMissOutcome(route('/regulations'), gates, index).status, 'skipped', 'a frame-only list is still deferred');
});
