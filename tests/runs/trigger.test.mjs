// RUN-1: what starts a ruled run (a push to main that changed a plan file; the ledger, tested in execute.test.ts, makes a changed plan safe). Also: the turn takes a push only for a ruled plan on main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

import { pendingPlans } from '../../scripts/ci/changes.mjs';

const P = 'scripts/runs/plans/2026-10-24-x.json';
const exists = (f) => f !== 'scripts/runs/plans/gone.json';

test('a push selects the changed plan files that still exist, and nothing else: a results file, a deleted plan, an odd name, a nested path, a source file select nothing; a push that changes no plan selects nothing', () => {
  assert.deepEqual(pendingPlans([P, 'scripts/runs/plans/gone.json', 'scripts/runs/results/x.json', 'scripts/runs/plans/a b.json', 'scripts/runs/plans/sub/x.json', 'src/x.ts'], exists), [P]);
  assert.deepEqual(pendingPlans(['src/x.ts', 'docs/y.md'], exists), []);
});

const turn = (extra) => spawnSync(process.execPath, ['scripts/turn.mjs', '--stage', 'all', '--mode', 'dry'], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', ...extra }, encoding: 'utf8' });

test('the turn refuses a push unless it carries a ruled plan AND is on main; a ruled push on main passes the event gate (and then fails for want of credentials, never skips)', () => {
  const refused = /a turn runs only on a dispatch \(this run is a push\)/;
  assert.match(turn({}).stderr, refused);
  assert.match(turn({ TURN_RULED_PLAN: 'p.json', GITHUB_REF: 'refs/heads/slice/x' }).stderr, refused);
  const r = turn({ TURN_RULED_PLAN: 'p.json', GITHUB_REF: 'refs/heads/main' });
  assert.doesNotMatch(r.stderr, refused);
  assert.equal(r.status, 1);
});

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const job = workflow.jobs['ruled-runs'];

test('the ruled-runs job: after changes and migrate, only on a push to main with pending plans, in the production environment with the turn job\'s secrets, one at a time, and it commits nothing', () => {
  assert.deepEqual(job.needs, ['changes', 'migrate']);
  assert.equal(job.environment, 'production');
  assert.deepEqual(job.env, workflow.jobs.turn.env, 'the same secrets as the turn job');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.match(job.if, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /needs\.changes\.outputs\.plans != ''/);
  assert.equal(job.permissions, undefined, 'it takes the read default: nothing is committed back');
  const steps = job.steps.map((s) => String(s.run ?? s.uses));
  assert.ok(steps.some((s) => /node scripts\/runs\/execute\.mjs \$PLANS/.test(s)), 'executes the pending plans');
  assert.ok(steps.some((s) => s.startsWith('actions/upload-artifact') && s.length > 0));
  assert.ok(!steps.some((s) => /git (commit|push)/.test(s)), 'no commit back to main');
  assert.match(readFileSync('scripts/runs/execute.mjs', 'utf8'), /GITHUB_STEP_SUMMARY/, 'the per-step table reaches the run page');
});
