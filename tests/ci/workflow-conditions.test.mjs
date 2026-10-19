import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobs = workflow.jobs;
const VARIABLES = ['ev', 'only', 'dstate', 'denv', 'parityScope', 'windowsScope'];
// Evaluates a job's `if` for an event, the dispatch input `only`, a deployment_status's state and environment, and the scope the `changes` job decided (the expressions use only ==, !=, &&, || and parentheses on those values).
const runs = (job, event, only = '', status = {}, scope = { parity: 'true', windows: 'true' }) => {
  const expr = String(jobs[job].if ?? 'true')
    .replaceAll('github.event_name', 'ev')
    .replaceAll('github.event.inputs.only', 'only')
    .replaceAll('github.event.deployment_status.state', 'dstate')
    .replaceAll('github.event.deployment_status.environment', 'denv')
    .replaceAll('needs.changes.outputs.parity', 'parityScope')
    .replaceAll('needs.changes.outputs.windows', 'windowsScope')
    .replaceAll('==', '===')
    .replaceAll('!=', '!==');
  return Function(...VARIABLES, `return (${expr});`)(event, only, status.state ?? '', status.environment ?? '', scope.parity, scope.windows);
};
const on = (event, only, status, scope) => Object.keys(jobs).filter((j) => j !== 'report' && runs(j, event, only, status, scope)).sort();

test('a dispatch with only empty runs everything but baseline, live and screens; only=baseline runs baseline alone; only=turn runs turn alone; only=live runs the live checks and the deployed-preview parity alone', () => {
  assert.deepEqual(on('workflow_dispatch', ''), ['changes', 'ci', 'parity', 'schema', 'turn', 'windows']);
  assert.deepEqual(on('workflow_dispatch', 'baseline'), ['baseline']);
  assert.deepEqual(on('workflow_dispatch', 'turn'), ['turn']);
  assert.deepEqual(on('workflow_dispatch', 'live'), ['live', 'preview-parity']);
});

test('a pull request never runs baseline, the turn or the live jobs; a push to main runs the checks and windows but not the turn, baseline or the live jobs', () => {
  assert.deepEqual(on('pull_request'), ['changes', 'ci', 'parity', 'schema', 'windows']);
  assert.deepEqual(on('push'), ['changes', 'ci', 'parity', 'schema', 'windows']);
});

test('the expensive jobs follow the scope the `changes` job decided on a pull request, and run unconditionally on a push to main', () => {
  assert.deepEqual(on('pull_request', '', {}, { parity: 'false', windows: 'false' }), ['changes', 'ci', 'schema']);
  assert.deepEqual(on('pull_request', '', {}, { parity: 'true', windows: 'false' }), ['changes', 'ci', 'parity', 'schema']);
  assert.deepEqual(on('pull_request', '', {}, { parity: 'false', windows: 'true' }), ['changes', 'ci', 'schema', 'windows']);
  assert.deepEqual(on('push', '', {}, { parity: 'false', windows: 'false' }), ['changes', 'ci', 'parity', 'schema', 'windows'], 'main is never skipped');
});

test('a successful PREVIEW deployment runs the live checks and the deployed-preview parity and nothing else; a failed, pending or production deployment runs nothing (production is checked by a dispatch, after the window)', () => {
  assert.deepEqual(on('deployment_status', '', { state: 'success', environment: 'Preview' }), ['live', 'preview-parity']);
  for (const status of [{ state: 'failure', environment: 'Preview' }, { state: 'pending', environment: 'Preview' }, { state: 'success', environment: 'Production' }, {}]) assert.deepEqual(on('deployment_status', '', status), [], JSON.stringify(status));
  assert.match(String(jobs.report.if), /deployment_status/, 'the report job does not run for a deployment event');
});

test('the preview-parity job checks out the DEPLOYED commit (its own capture and compare) and passes the preview URL; the live job checks out the default branch and gets the deployed sha as data', () => {
  const checkout = (name) => jobs[name].steps.find((s) => String(s.uses).startsWith('actions/checkout'));
  assert.match(String(checkout('preview-parity').with.ref), /github\.event\.deployment\.sha/);
  assert.match(String(jobs.live.env.LIVE_BASE_URL), /deployment_status\.environment_url/);
  assert.match(String(jobs.live.env.LIVE_CODE_SHA), /github\.event\.deployment\.sha/);
  assert.match(String(checkout('live').with.ref), /github\.event\.repository\.default_branch/);
});

// G13: a pull request or a preview deployment runs code its author controls. No such run may hold a secret that can write or read production beyond a throwaway member account.
const HIGH = ['SUPABASE_SERVICE_ROLE_KEY', 'WORKER_SECRET', 'LIVE_ADMIN_EMAIL', 'LIVE_ADMIN_PASSWORD', 'RESEND_API_KEY', 'INVITATION_FROM_EMAIL', 'EIA_API_KEY'];
// The deployment-protection bypass opens previews of this project and nothing else: it may sit in the jobs that photograph or check a deployed preview (a deployment or a dispatch), never in a job that runs on a pull request or a push.
const PROTECTION_BYPASS = 'VERCEL_AUTOMATION_BYPASS_SECRET';
const secretsOf = (job) => {
  const blocks = [jobs[job].env ?? {}, ...jobs[job].steps.map((s) => s.env ?? {})];
  return new Set(blocks.flatMap((b) => Object.values(b)).flatMap((v) => [...String(v).matchAll(/secrets\.(\w+)/g)].map((m) => m[1])));
};
// A ref that names a pull request's or a deployment's commit puts that code in the workspace.
const PR_CODE = /github\.event\.deployment\.sha|github\.head_ref|pull_request\.head|github\.sha|github\.ref\b/;
const checkoutRefs = (job) => jobs[job].steps.filter((s) => String(s.uses).startsWith('actions/checkout')).map((s) => String(s.with?.ref ?? ''));

test('G13: a job that holds a high-privilege secret never runs on a pull request or a push, and never runs the pull request\'s or the deployed commit\'s code', () => {
  for (const job of Object.keys(jobs)) {
    const high = [...secretsOf(job)].filter((s) => HIGH.includes(s));
    if (!high.length) continue;
    for (const event of ['pull_request', 'push']) assert.ok(!runs(job, event), `${job} holds ${high} and runs on a ${event}`);
    // On a deployment_status event the default checkout is the default branch, but the job may check out the deployed commit: forbidden for these jobs. A dispatch runs the branch the operator chose and says so.
    if (job !== 'turn' && job !== 'screens') for (const ref of checkoutRefs(job)) assert.doesNotMatch(ref, PR_CODE, `${job} (${high}) checks out ${ref}: a branch could change the script that holds the secrets`);
  }
});

test('G13: the deployment-protection bypass is held only by the jobs that check a deployed preview, and by none that runs on a pull request or a push', () => {
  const holders = Object.keys(jobs).filter((job) => secretsOf(job).has(PROTECTION_BYPASS)).sort();
  assert.deepEqual(holders, ['live', 'preview-parity', 'screens']);
  for (const job of holders) for (const event of ['pull_request', 'push']) assert.ok(!runs(job, event), `${job} holds the bypass and runs on a ${event}`);
});

test('G13: the jobs that run a pull request\'s own code hold the member test account and the public anon key, never the admin account, the service key or a mail key', () => {
  for (const job of ['parity', 'preview-parity', 'ci', 'schema', 'windows']) {
    const used = [...secretsOf(job)];
    assert.deepEqual(used.filter((s) => HIGH.includes(s)), [], `${job}`);
  }
  assert.deepEqual([...secretsOf('turn')].sort(), ['EIA_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WORKER_SECRET']);
  assert.deepEqual(jobs.turn.if.includes('workflow_dispatch'), true, 'the turn job is a dispatch job');
});

test('G13: no workflow input or event field is interpolated into a shell command; each reaches the step through env', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      const run = String(step.run ?? '');
      const hit = run.match(/\$\{\{[^}]*(inputs\.|github\.event\.|github\.head_ref|github\.base_ref)[^}]*\}\}/);
      assert.equal(hit, null, `${name}: ${step.name ?? run.slice(0, 40)} interpolates ${hit?.[0]} into a shell command`);
    }
  }
});

test('G13: every action is pinned to a commit SHA, and the concurrency group names the event and the run so a pending push to main is never replaced by a dispatch', () => {
  const uses = Object.values(jobs).flatMap((j) => (j.steps ?? []).map((s) => s.uses).filter(Boolean));
  assert.ok(uses.length > 20);
  for (const u of uses) assert.match(u, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, u);
  assert.match(workflow.concurrency.group, /github\.event_name/);
  assert.match(workflow.concurrency.group, /github\.run_id/);
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('G3: no step turns exit 2 into success: a green job means the check ran, and the report waits for every job that can run on a pull request', () => {
  for (const [name, job] of Object.entries(jobs)) for (const step of job.steps ?? []) assert.doesNotMatch(String(step.run ?? ''), /-eq 2|== 2|exit 0.*self-skip|self-skipped \(exit 2\)/, `${name}: ${step.name ?? ''}`);
  assert.deepEqual([...jobs.report.needs].sort(), ['changes', 'ci', 'parity', 'schema', 'turn', 'windows']);
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

test('the parity job runs every smoke, the capture and the compare whatever an earlier one did', () => {
  const steps = jobs.parity.steps;
  const smokes = steps.filter((s) => /tests\/ux\/.*-smoke\.mjs/.test(String(s.run ?? '')));
  assert.equal(smokes.length, 7);
  for (const s of [...smokes, ...steps.filter((x) => /parity\/(capture|compare)\.mjs/.test(String(x.run ?? '')))]) assert.match(String(s.if), /!cancelled\(\)/, s.name);
});
