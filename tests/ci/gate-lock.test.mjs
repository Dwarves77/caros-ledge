// GATES-LOCK-1: two lanes on one workstation never run the heavy gates (build, tests, schema:local) at once. withLock is a cross-process lock on an atomic mkdir; the test runner is capped so one lane cannot take every core.
// Every case uses its own lock directory, never the real <tmpdir>/caros-ledge-gates, because this file itself runs inside the gates' held lock.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { withLock } from '../../scripts/ci/lib/lock.mjs';
import { testArgs, testConcurrency } from '../../scripts/ci/test.mjs';

const libUrl = pathToFileURL(join(process.cwd(), 'scripts/ci/lib/lock.mjs')).href;
const dirOf = () => mkdtempSync(join(tmpdir(), 'gate-lock-'));
const noCi = () => ({ ...process.env, CI: '', GITHUB_ACTIONS: '' });

/** A child that takes the lock `name` in `dir`, prints timestamped acquire and release lines, and holds it up to `holdMs` (a `go` file in the lock directory's parent ends it early) or until `signal` is raised on itself. */
const child = (dir, holdMs, signal = '') =>
  spawn(process.execPath, ['--input-type=module', '-e', `
    import { withLock } from ${JSON.stringify(libUrl)};
    const say = (m) => console.log(m + ' ' + Date.now());
    await withLock('t', async () => {
      say('acquired');
      if (${JSON.stringify(signal)}) { await new Promise((r) => setTimeout(r, 100)); if (process.platform === 'win32') process.emit(${JSON.stringify(signal)}); else process.kill(process.pid, ${JSON.stringify(signal)}); }
      for (let i = 0; i < ${holdMs}; i += 25) { await new Promise((r) => setTimeout(r, 25)); if (${holdMs} > 1000 && (await import('node:fs')).existsSync(${JSON.stringify(dir + '/go')})) break; }
      say('released');
    }, { dir: ${JSON.stringify(dir)}, pollMs: 50 });
  `], { env: noCi(), stdio: ['ignore', 'pipe', 'pipe'] });

const collect = (c) => {
  const o = { out: '', code: null, done: new Promise((r) => c.on('close', (code) => r((o.code = code)))) };
  c.stdout.on('data', (d) => (o.out += d));
  c.stderr.on('data', (d) => (o.out += d));
  return o;
};
const waitFor = async (o, text) => { for (let i = 0; i < 200 && !o.out.includes(text); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(o.out.includes(text), `never saw "${text}" in: ${o.out}`); };
const at = (o, what) => Number(new RegExp(`${what} (\\d+)`).exec(o.out)?.[1] ?? assert.fail(`no "${what}" in: ${o.out}`));

test('a second process waits until the first releases, then runs (order by timestamps), and says who it waits for', async () => {
  const dir = dirOf();
  const a = collect(child(dir, 20_000));
  await waitFor(a, 'acquired');
  const b = collect(child(dir, 0));
  await waitFor(b, 'waiting for');
  assert.ok(!b.out.includes('acquired'), 'B must not run while A holds');
  writeFileSync(join(dir, 'go'), '');
  await Promise.all([a.done, b.done]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  assert.ok(at(b, 'acquired') >= at(a, 'released'), `B acquired at ${at(b, 'acquired')} before A released at ${at(a, 'released')}`);
  assert.match(b.out, /^t: waiting for \d+ since \d{4}-\d\d-\d\dT/m);
});

test('a lock whose holder pid is dead is broken with a logged line, then taken', async () => {
  const dir = dirOf();
  const gone = spawnSync(process.execPath, ['-e', '0']);
  mkdirSync(join(dir, 't.lock'));
  writeFileSync(join(dir, 't.lock', 'holder.json'), JSON.stringify({ pid: gone.pid, at: Date.now() }));
  const lines = [];
  let ran = false;
  await withLock('t', () => (ran = true), { dir, pollMs: 20, log: (l) => lines.push(l), ci: false });
  assert.ok(ran);
  assert.match(lines.join('\n'), /broke a stale lock held by \d+/);
  assert.ok(!existsSync(join(dir, 't.lock')), 'released after the run');
});

test('a lock older than staleMs is broken even when its pid is alive', async () => {
  const dir = dirOf();
  mkdirSync(join(dir, 't.lock'));
  writeFileSync(join(dir, 't.lock', 'holder.json'), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  const lines = [];
  await withLock('t', () => 1, { dir, staleMs: 30_000, pollMs: 20, log: (l) => lines.push(l), ci: false });
  assert.match(lines.join('\n'), /broke a stale lock/);
});

test('SIGINT in the holder releases the lock (and exits 130)', async () => {
  const dir = dirOf();
  const h = collect(child(dir, 5000, 'SIGINT'));
  await h.done;
  assert.equal(h.code, 130);
  assert.ok(!h.out.includes('released'), 'it was interrupted, not finished');
  assert.ok(!existsSync(join(dir, 't.lock')), 'the lock directory is gone after the interrupt');
});

test('CI (CI or GITHUB_ACTIONS) bypasses the lock even when it is held', async () => {
  const dir = dirOf();
  mkdirSync(join(dir, 't.lock'));
  writeFileSync(join(dir, 't.lock', 'holder.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const saved = { CI: process.env.CI, GA: process.env.GITHUB_ACTIONS };
  try {
    for (const key of ['CI', 'GITHUB_ACTIONS']) {
      process.env.CI = '';
      process.env.GITHUB_ACTIONS = '';
      process.env[key] = 'true';
      assert.equal(await withLock('t', () => 'ran', { dir, pollMs: 20 }), 'ran', `${key} bypasses`);
    }
  } finally {
    process.env.CI = saved.CI ?? '';
    process.env.GITHUB_ACTIONS = saved.GA ?? '';
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 't.lock', 'holder.json'), 'utf8')).pid, process.pid, 'the held lock was not touched');
});

test('the test runner takes max(2, floor(cores / 2)) files at once and the test script goes through it', () => {
  assert.equal(testConcurrency(32), 16);
  assert.equal(testConcurrency(8), 4);
  assert.equal(testConcurrency(3), 2);
  assert.equal(testConcurrency(1), 2);
  assert.ok(testArgs(8).includes('--test-concurrency=4'));
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).scripts.test, 'node scripts/ci/test.mjs');
});
