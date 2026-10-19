import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BYPASS_HEADER, bypassHeaders, discoveryMissOutcome, pathFor, isThrottled, pickDetailHref, retryWaitMs, throttleWaitMs, throttleEvents, THROTTLE_FALLBACK_MS, THROTTLE_CEILING_MS, pinnedPath } from './capture.mjs';

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

const declared = JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8')).routes;
const gated = JSON.parse(readFileSync(new URL('./approved-changes.json', import.meta.url), 'utf8')).gates.full;

for (const [name, list, first] of [['research-detail', '/research', '/research/r-42'], ['operations-detail', '/operations', '/operations/o-7']]) {
  test(`${name} is declared, gated full, and resolves the first detail link from a fixture link set`, () => {
    const route = declared.find((r) => r.name === name);
    assert.ok(route, `${name} in routes.json`);
    assert.ok(gated.includes(name), `${name} in gates.full`);
    assert.equal(route.discover.list, list);
    const hrefs = [list, '#legend', 'https://elsewhere.example/x/y', '/dashboard', `${list}/`, first, `${list}/other`, `${list}/with/depth`];
    assert.equal(pickDetailHref(hrefs, new URL(list, 'https://site.example'), route), first);
    assert.equal(pickDetailHref(hrefs.filter((h) => h !== first), new URL(list, 'https://site.example'), route), `${list}/other`);
    assert.equal(pickDetailHref([list, '/dashboard', `${list}/a/b`], new URL(list, 'https://site.example'), route), null);
  });
}

test('a route whose baseline holds a path is captured at that path on the new site; without one, discovery runs', () => {
  const index = { routes: [{ name: 'x-detail', path: '/x/pinned', files: ['x-detail.1280x900'] }, { name: 'y-detail', path: '/y/none', files: [] }] };
  assert.equal(pinnedPath(route('/x'), index, undefined), '/x/pinned', 'the baseline item is the item captured');
  assert.equal(pinnedPath(route('/x'), index, 'old'), null, 'the old site always discovers (a recapture is fresh)');
  assert.equal(pinnedPath({ name: 'y-detail', discover: {} }, index, undefined), null, 'no files, no pin');
  assert.equal(pinnedPath({ name: 'z-detail', discover: {} }, index, undefined), null, 'no entry, discovery runs');
  assert.equal(pinnedPath(route('/x'), undefined, undefined), null);
});

test('a page answered 429 while loading is a throttled attempt; a 503 (a failed read that recurs) and any other status are not', () => {
  assert.equal(isThrottled([{ status: 200 }, { status: 429 }]), true);
  assert.equal(isThrottled([{ status: 503, retryAfter: '1' }]), false);
  assert.equal(isThrottled([200, 204, 401, 404, 500].map((status) => ({ status }))), false);
  assert.equal(throttleEvents([{ status: 200 }, { status: 429, retryAfter: '3' }]).length, 1);
});

test('the wait is what the server asked for: seconds or an HTTP date; the fallback only when the header is absent; a ceiling bounds it', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(retryWaitMs('7', now), 7000);
  assert.equal(retryWaitMs('Sun, 18 Oct 2026 00:00:20 GMT', now), 20000);
  assert.equal(retryWaitMs('Sat, 17 Oct 2026 00:00:00 GMT', now), 0, 'a date in the past is no wait');
  assert.equal(retryWaitMs(undefined, now), THROTTLE_FALLBACK_MS);
  assert.equal(retryWaitMs('garbage', now), THROTTLE_FALLBACK_MS);
  assert.equal(retryWaitMs('999999', now), THROTTLE_CEILING_MS);
  assert.equal(throttleWaitMs([{ status: 429, retryAfter: '4' }, { status: 429, retryAfter: '9' }, { status: 429 }], now), THROTTLE_FALLBACK_MS, 'the longest ask wins');
});

test('the protection-bypass header goes to the captured origin when the secret is set, and to nobody when it is not or when the request is a third-party one', () => {
  const origin = 'https://preview.example.test';
  const env = { VERCEL_AUTOMATION_BYPASS_SECRET: 'value-from-the-environment' };
  assert.deepEqual(bypassHeaders(`${origin}/login`, origin, env), { [BYPASS_HEADER]: 'value-from-the-environment' });
  assert.deepEqual(bypassHeaders(`${origin}/api/x?y=1`, origin, env), { [BYPASS_HEADER]: 'value-from-the-environment' });
  assert.deepEqual(bypassHeaders(`${origin}/login`, origin, {}), {}, 'no secret, no header');
  assert.deepEqual(bypassHeaders(`${origin}/login`, origin, { VERCEL_AUTOMATION_BYPASS_SECRET: '' }), {}, 'an empty secret is no secret');
  assert.deepEqual(bypassHeaders('https://elsewhere.example.test/tile.png', origin, env), {}, 'a third party never receives it');
  assert.deepEqual(bypassHeaders('https://preview.example.test.evil.test/', origin, env), {}, 'a look-alike host never receives it');
});
