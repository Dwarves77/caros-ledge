// The masthead of the signed-out pages (home, login, signup) prints the visitor's own date and ISO week (src/features/auth/ui/AuthFrame.tsx reads `new Date()` after hydration), and those three routes are pixelExact. A capture that
// lets the browser's clock run draws a different date than the baseline PNG on every day after the baseline was shot, and the pixel diff grows with the weekday and the week number while no design has changed. So the capture pins the page's
// clock to the instant the baseline was shot on (CAPTURE_NOW), for signed-out routes only: a signed-in route's date is the server's, and its session needs a clock that agrees with the token.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { freezeClock } from './capture.mjs';
import { CAPTURE_NOW } from './contract.mjs';

const context = () => {
  const calls = [];
  return { calls, clock: { setFixedTime: async (at) => void calls.push(at) } };
};

test('the pinned instant is the day the baseline was captured on, as its README states', () => {
  const readme = readFileSync(new URL('./baseline/README.md', import.meta.url), 'utf8');
  const stated = readme.match(/date (\d{4}-\d{2}-\d{2})/)?.[1];
  assert.ok(stated, 'the baseline README states no capture date');
  assert.equal(new Date(CAPTURE_NOW).toISOString().slice(0, 10), stated);
  assert.equal(new Date(CAPTURE_NOW).getUTCHours(), 12, 'noon UTC: the same calendar day in every zone from UTC-11 to UTC+11');
});

test('a signed-out route is captured on the pinned instant, a signed-in route on the real clock', async () => {
  const out = context();
  await freezeClock(out, { name: 'home', auth: false });
  assert.deepEqual(out.calls, [new Date(CAPTURE_NOW)]);
  const member = context();
  await freezeClock(member, { name: 'regulations', auth: 'member' });
  const admin = context();
  await freezeClock(admin, { name: 'admin', auth: 'admin' });
  assert.deepEqual([member.calls.length, admin.calls.length], [0, 0]);
});

test('the pinned clock is the only thing that fixes the date: a route without an auth field is signed out', async () => {
  const out = context();
  await freezeClock(out, { name: 'privacy' });
  assert.equal(out.calls.length, 1);
});
