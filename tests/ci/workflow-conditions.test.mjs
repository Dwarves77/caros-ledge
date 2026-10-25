import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobs = workflow.jobs;
const VARIABLES = ['ev', 'only', 'sctx', 'sstate', 'production', 'ref', 'isFork', 'parityScope', 'windowsScope', 'edgeScope', 'plansScope', 'migrateResult', 'sender', 'targetUrl', 'startsWith'];
// The ref the run is on and whether the repository is a fork (a test sets them for one case and puts them back).
const where = { ref: 'refs/heads/main', fork: false };
// Evaluates a job's `if` for an event, the dispatch input `only`, a status event's context and state, whether the target job derived production, and the scope the `changes` job decided (the expressions use only ==, !=, &&, || and parentheses on those values).
const runs = (job, event, only = '', status = {}, scope = { parity: 'true', windows: 'true', edge: 'false' }, production = '', migrateResult = 'success') => {
  const expr = String(jobs[job].if ?? 'true')
    .replace(/^\$\{\{|\}\}$/g, '')
    .replaceAll('!cancelled()', 'true')
    .replaceAll('github.event_name', 'ev')
    .replaceAll('github.event.inputs.only', 'only')
    .replaceAll('github.event.repository.fork', 'isFork')
    .replaceAll('github.ref', 'ref')
    .replaceAll('github.event.context', 'sctx')
    .replaceAll('github.event.state', 'sstate')
    .replaceAll('github.event.sender.login', 'sender')
    .replaceAll('github.event.target_url', 'targetUrl')
    .replaceAll('needs.target.outputs.production', 'production')
    .replaceAll('needs.changes.outputs.parity', 'parityScope')
    .replaceAll('needs.changes.outputs.windows', 'windowsScope')
    .replaceAll('needs.changes.outputs.edge', 'edgeScope')
    .replaceAll('needs.changes.outputs.plans', 'plansScope')
    .replaceAll('needs.migrate.result', 'migrateResult')
    .replaceAll('==', '===')
    .replaceAll('!=', '!==');
  return Function(...VARIABLES, `return (${expr});`)(event, only, status.context ?? '', status.state ?? '', production, where.ref, where.fork, scope.parity, scope.windows, scope.edge ?? 'false', scope.plans ?? '', migrateResult, status.sender ?? '', status.target_url ?? '', (value, prefix) => String(value).startsWith(prefix));
};
// The jobs that run: a job whose `if` holds AND whose needs all ran (a job with no status function in its `if` is skipped with a skipped need; edge-deploy's `!cancelled()` states its own rule on needs.migrate.result).
const on = (event, only, status, scope, production, migrateResult) => {
  const ran = new Set();
  for (let pass = 0; pass < Object.keys(jobs).length; pass += 1) {
    for (const j of Object.keys(jobs)) {
      if (j === 'report' || ran.has(j) || !runs(j, event, only, status, scope, production, migrateResult)) continue;
      const needs = [jobs[j].needs ?? []].flat();
      if (String(jobs[j].if).includes('!cancelled()') || needs.every((n) => ran.has(n))) ran.add(j);
    }
  }
  return [...ran].sort();
};
// The status Vercel really posts (read with `gh api repos/Dwarves77/caros-ledge/commits/<sha>/statuses`): creator vercel[bot], target_url on vercel.com.
const VERCEL_OK = { context: 'Vercel', state: 'success', sender: 'vercel[bot]', target_url: 'https://vercel.com/dwarves77s-projects/caros-ledge/ByMHeLDZdiCHgaD8tZqnooCRd1jQ' };

test('a dispatch with only empty runs everything but baseline, live and screens; only=baseline runs baseline alone; only=turn runs turn alone; only=live runs the live checks and the deployed-preview parity alone', () => {
  assert.deepEqual(on('workflow_dispatch', ''), ['changes', 'ci', 'parity', 'schema', 'turn', 'windows']);
  assert.deepEqual(on('workflow_dispatch', 'baseline'), ['baseline']);
  assert.deepEqual(on('workflow_dispatch', 'turn'), ['turn']);
  assert.deepEqual(on('workflow_dispatch', 'live'), ['live', 'preview-parity', 'target']);
});

test('a pull request never runs baseline, the turn or the live jobs; a push to main runs the checks and windows but not the turn, baseline or the live jobs', () => {
  assert.deepEqual(on('pull_request'), ['changes', 'ci', 'parity', 'schema', 'windows']);
  assert.deepEqual(on('push'), ['changes', 'ci', 'migrate', 'parity', 'schema', 'windows']);
});

test('the expensive jobs follow the scope the `changes` job decided on a pull request, and run unconditionally on a push to main', () => {
  assert.deepEqual(on('pull_request', '', {}, { parity: 'false', windows: 'false' }), ['changes', 'ci', 'schema']);
  assert.deepEqual(on('pull_request', '', {}, { parity: 'true', windows: 'false' }), ['changes', 'ci', 'parity', 'schema']);
  assert.deepEqual(on('pull_request', '', {}, { parity: 'false', windows: 'true' }), ['changes', 'ci', 'schema', 'windows']);
  assert.deepEqual(on('push', '', {}, { parity: 'false', windows: 'false' }), ['changes', 'ci', 'migrate', 'parity', 'schema', 'windows'], 'main is never skipped');
});

test('migrate runs on a push to main and on a dispatch with only=migrate on any ref, nowhere else: not on a pull request, a fork, a push to another branch, another dispatch or a status; it holds the one database secret and writes nothing to the repository', () => {
  assert.ok(on('push').includes('migrate'));
  assert.deepEqual(on('workflow_dispatch', 'migrate'), ['migrate']);
  for (const [event, only] of [['pull_request', ''], ['workflow_dispatch', ''], ['workflow_dispatch', 'live'], ['workflow_dispatch', 'turn'], ['status', '']]) assert.ok(!on(event, only, VERCEL_OK).includes('migrate'), `${event} only=${only}`);
  try {
    where.fork = true;
    assert.ok(!on('push').includes('migrate'), 'a fork never migrates production');
    assert.ok(!on('workflow_dispatch', 'migrate').includes('migrate'));
    where.fork = false;
    where.ref = 'refs/heads/slice/x';
    assert.ok(!on('push').includes('migrate'), 'a push to a branch other than main never migrates production');
    assert.deepEqual(on('workflow_dispatch', 'migrate'), ['migrate'], 'a dispatch on a slice branch applies the pending migrations of that branch ahead of its code (standing rule 3)');
    assert.ok(!on('workflow_dispatch', 'edge-deploy').includes('migrate'));
    assert.ok(!on('workflow_dispatch', 'edge-deploy').includes('edge-deploy'), 'the edge deploy stays main-only');
    assert.ok(!on('pull_request', '').includes('migrate'), 'a pull request on a branch never migrates');
  } finally {
    where.ref = 'refs/heads/main';
    where.fork = false;
  }
  assert.deepEqual([...secretsOf('migrate')], ['SUPABASE_DB_URL']);
  for (const job of Object.keys(jobs).filter((j) => j !== 'migrate')) assert.ok(!secretsOf(job).has('SUPABASE_DB_URL'), `${job} must not hold the database secret`);
  assert.equal(jobs.migrate.permissions, undefined, 'migrate writes nothing to the repository: it takes the workflow default (read)');
  for (const job of Object.keys(jobs)) assert.notEqual(jobs[job].permissions?.contents, 'write', `${job} must not write the repository: main is protected and nothing in CI commits`);
});

test('edge-deploy runs on a push to main that changed the function (edge output true) after a successful migrate, and on a dispatch with only=edge-deploy; nowhere else; it needs migrate and holds only SUPABASE_ACCESS_TOKEN', () => {
  const edge = { parity: 'true', windows: 'true', edge: 'true' };
  assert.ok(on('push', '', {}, edge).includes('edge-deploy'));
  assert.ok(!on('push').includes('edge-deploy'), 'a push that changed no function skips it');
  assert.ok(!on('push', '', {}, edge, '', 'failure').includes('edge-deploy'), 'a failed migrate stops the deploy');
  assert.ok(!on('push', '', {}, edge, '', 'skipped').includes('edge-deploy'));
  assert.deepEqual(on('workflow_dispatch', 'edge-deploy'), ['edge-deploy']);
  for (const [event, only] of [['pull_request', ''], ['workflow_dispatch', ''], ['workflow_dispatch', 'migrate'], ['workflow_dispatch', 'live'], ['status', '']]) assert.ok(!on(event, only, VERCEL_OK, edge).includes('edge-deploy'), `${event} only=${only}`);
  try {
    where.fork = true;
    assert.ok(!on('push', '', {}, edge).includes('edge-deploy') && !on('workflow_dispatch', 'edge-deploy').includes('edge-deploy'), 'a fork never deploys');
    where.fork = false;
    where.ref = 'refs/heads/slice/x';
    assert.ok(!on('push', '', {}, edge).includes('edge-deploy') && !on('workflow_dispatch', 'edge-deploy').includes('edge-deploy'), 'a branch other than main never deploys');
  } finally {
    where.ref = 'refs/heads/main';
    where.fork = false;
  }
  assert.deepEqual(jobs['edge-deploy'].needs, ['changes', 'migrate']);
  assert.deepEqual([...secretsOf('edge-deploy')], ['SUPABASE_ACCESS_TOKEN']);
  for (const job of Object.keys(jobs).filter((j) => j !== 'edge-deploy')) assert.ok(!secretsOf(job).has('SUPABASE_ACCESS_TOKEN'), `${job} must not hold the deploy token`);
  const run = jobs['edge-deploy'].steps.map((s) => String(s.run ?? '')).join('\n');
  assert.match(run, /npx --no-install supabase@2\.121\.0 functions deploy capture-worker --project-ref "\$ref" --use-api/);
  assert.doesNotMatch(run, /supabase@2 /, 'the CLI is never invoked by a floating major');
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).devDependencies.supabase, '2.121.0', 'the version the job invokes is the devDependency the lockfile covers');
  assert.match(run, /ref=kwrsbpiseruzbfwjpvsp/);
  assert.match(run, /missing \(exit 1\): SUPABASE_ACCESS_TOKEN/);
});

test('the live jobs run on the successful Vercel commit status and on nothing else: not on a failed, pending or other-context status, not on a push, a pull request or a deployment event; a production status skips the preview parity', () => {
  assert.deepEqual(on('status', '', VERCEL_OK), ['live', 'preview-parity', 'target']);
  assert.deepEqual(on('status', '', VERCEL_OK, undefined, 'true'), ['live', 'target'], 'the default branch is production: live runs against it, the preview parity does not');
  for (const status of [{ ...VERCEL_OK, state: 'failure' }, { ...VERCEL_OK, state: 'pending' }, { ...VERCEL_OK, state: 'error' }, { ...VERCEL_OK, context: 'Vercel Preview Comments' }, { ...VERCEL_OK, context: 'ci' }, {}]) assert.deepEqual(on('status', '', status), [], JSON.stringify(status));
  // Audit 2.3.10 / 2.4: anyone with statuses:write can post a status named Vercel. Only the Vercel app (sender vercel[bot]) with a link into vercel.com starts the live jobs; `live` and `preview-parity` need `target`, so a spoof starts none of them.
  for (const spoof of [{ ...VERCEL_OK, sender: 'some-collaborator' }, { ...VERCEL_OK, sender: 'vercel-bot' }, { ...VERCEL_OK, sender: '' }, { ...VERCEL_OK, target_url: 'https://evil.example/https://vercel.com/' }, { ...VERCEL_OK, target_url: 'http://vercel.com/x' }, { ...VERCEL_OK, target_url: 'https://vercel.com.evil.example/x' }, { ...VERCEL_OK, target_url: '' }]) assert.deepEqual(on('status', '', spoof), [], JSON.stringify(spoof));
  assert.deepEqual([jobs.live.needs, jobs['preview-parity'].needs], ['target', 'target']);
  for (const event of ['push', 'pull_request', 'deployment_status']) assert.ok(!on(event, '', VERCEL_OK).some((j) => ['live', 'preview-parity', 'target'].includes(j)), event);
  assert.ok(workflow.on && 'status' in workflow.on && !('deployment_status' in workflow.on), 'the workflow listens for status, not for a deployment event Vercel never posts');
  assert.match(String(jobs.report.if), /'status'/, 'the report job does not run for a status event');
  for (const job of ['changes', 'ci', 'schema', 'windows', 'parity']) assert.deepEqual([job, runs(job, 'status', '', VERCEL_OK)], [job, false], 'a status event starts no check job');
});

test('the deployed URL is derived from the status: the branch lower-cased, every character outside [a-z0-9] replaced by a dash; the default branch is production; a status with no branch fails', () => {
  const step = jobs.target.steps.find((s) => s.id === 'url');
  const derive = (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'target-'));
    try {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const bashCmd = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
      const r = spawnSync(bashCmd, ['-c', step.run], { env: { PATH: process.env.PATH, EVENT: 'status', DEFAULT_BRANCH: 'main', LIVE_URL: '', BRANCH: '', ...env, GITHUB_OUTPUT: out }, encoding: 'utf8' });
      return { status: r.status, out: readFileSync(out, 'utf8').trim().split('\n').filter(Boolean) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(derive({ BRANCH: 'slice/r1a' }).out, ['url=https://caros-ledge-git-slice-r1a-dwarves77s-projects.vercel.app', 'production=false']);
  assert.deepEqual(derive({ BRANCH: 'coord/Report_2' }).out, ['url=https://caros-ledge-git-coord-report-2-dwarves77s-projects.vercel.app', 'production=false']);
  assert.deepEqual(derive({ BRANCH: 'main' }).out, ['url=https://carosledge.com', 'production=true']);
  assert.deepEqual(derive({ EVENT: 'workflow_dispatch', LIVE_URL: 'https://x.test' }).out, ['url=https://x.test', 'production=false']);
  assert.equal(derive({ BRANCH: '' }).status, 1, 'a status that names no branch cannot be located');
  assert.deepEqual([jobs.live.needs, jobs.live.env.LIVE_BASE_URL], ['target', '${{ needs.target.outputs.url }}']);
  assert.deepEqual([jobs['preview-parity'].needs, jobs['preview-parity'].env.PARITY_BASE], ['target', '${{ needs.target.outputs.url }}']);
});

test('the preview-parity job and the live job check out the DEFAULT BRANCH (a branch cannot change the scripts that hold the member account and the bypass secret); the deployed sha is data', () => {
  const checkout = (name) => jobs[name].steps.find((s) => String(s.uses).startsWith('actions/checkout'));
  assert.match(String(checkout('preview-parity').with.ref), /github\.event\.repository\.default_branch/);
  assert.match(String(jobs.live.env.LIVE_CODE_SHA), /github\.event\.sha/);
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
const PR_CODE = /github\.event\.sha|github\.head_ref|pull_request\.head|github\.sha|github\.ref\b/;
const checkoutRefs = (job) => jobs[job].steps.filter((s) => String(s.uses).startsWith('actions/checkout')).map((s) => String(s.with?.ref ?? ''));

test('G13: a job that holds a high-privilege secret never runs on a pull request or a push, and never runs the pull request\'s or the deployed commit\'s code', () => {
  for (const job of Object.keys(jobs)) {
    const high = [...secretsOf(job)].filter((s) => HIGH.includes(s));
    if (!high.length) continue;
    for (const event of ['pull_request', 'push']) assert.ok(!runs(job, event), `${job} holds ${high} and runs on a ${event}`);
    // RUN-1: the one deliberate exception, `ruled-runs`, runs on a push to main that carries a pending plan (merged, reviewed code) and on nothing else: never a pull request, never another ref, never a fork.
    if (job === 'ruled-runs') continue;
    // On a status event the default checkout is the default branch, but the job may check out the deployed commit: forbidden for these jobs. A dispatch runs the branch the operator chose and says so.
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
  assert.ok(!on('status', '', VERCEL_OK).includes('screens'));
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

test('audit 2.3.10: the production admin account reaches the live job only for production or a dispatch, never for a branch preview', () => {
  const when = "(needs.target.outputs.production == 'true' || github.event_name == 'workflow_dispatch')";
  for (const name of ['LIVE_ADMIN_EMAIL', 'LIVE_ADMIN_PASSWORD']) assert.ok(String(jobs.live.env[name]).includes(when) && String(jobs.live.env[name]).endsWith("|| '' }}"), name);
  assert.ok(String(jobs.live.env.LIVE_ADMIN_PAGES).includes(when) && String(jobs.live.env.LIVE_ADMIN_PAGES).includes("'on' || 'off'"));
});

test('audit 2.3.12 and 2.3.13: migrate, turn and ruled-runs (RUN-1) run in the production environment (the required reviewers sit there, if the repository sets any); no other job names an environment', () => {
  assert.equal(jobs.migrate.environment, 'production');
  assert.equal(jobs.turn.environment, 'production');
  assert.deepEqual(Object.keys(jobs).filter((j) => jobs[j].environment !== undefined).sort(), ['migrate', 'ruled-runs', 'turn']);
});

test('every upload-artifact keeps its artifact 3 days', () => {
  const uploads = Object.values(jobs).flatMap((j) => (j.steps ?? []).filter((s) => String(s.uses).startsWith('actions/upload-artifact')));
  assert.ok(uploads.length >= 5);
  for (const u of uploads) assert.equal(u.with['retention-days'], 3, u.with.name);
});

test('only the report job holds a token that writes to a pull request, and it runs the default branch\'s scripts with the tree under report beside them as data', () => {
  for (const [name, job] of Object.entries(jobs)) assert.equal(job.permissions?.['pull-requests'], name === 'report' ? 'write' : undefined, name);
  const checkouts = jobs.report.steps.filter((s) => String(s.uses).startsWith('actions/checkout'));
  assert.match(String(checkouts[0].with.ref), /github\.event\.repository\.default_branch/);
  assert.equal(checkouts[1].with.path, 'pr-tree');
  assert.equal(checkouts[1].with['persist-credentials'], false);
  assert.equal(jobs.report.steps.find((s) => String(s.run).includes('pr-comment.mjs')).env.LOC_ROOT, 'pr-tree');
});

test('no install runs a package install script: every npm ci and every npm install in a job is --ignore-scripts', () => {
  const installs = Object.entries(jobs).flatMap(([name, job]) => (job.steps ?? []).flatMap((s) => String(s.run ?? '').split('\n').filter((l) => /\bnpm (ci|install)\b/.test(l)).map((l) => [name, l])));
  assert.ok(installs.length >= 10);
  for (const [name, line] of installs) assert.match(line, /--ignore-scripts/, `${name}: ${line.trim()}`);
});

test('RUN-1: ruled-runs runs on a push to main that changed a pending plan, after migrate, and on nothing else: not without a pending plan, not on a pull request, a dispatch, a status, another ref or a fork', () => {
  const pending = { parity: 'true', windows: 'true', edge: 'false', plans: 'scripts/runs/plans/2026-10-24-arm-1.json' };
  assert.ok(on('push', '', {}, pending).includes('ruled-runs'));
  assert.ok(!on('push').includes('ruled-runs'), 'a push that changed no plan runs nothing');
  for (const [event, only] of [['pull_request', ''], ['workflow_dispatch', ''], ['workflow_dispatch', 'turn'], ['status', '']]) assert.ok(!on(event, only, VERCEL_OK, pending).includes('ruled-runs'), `${event} only=${only}`);
  try {
    where.ref = 'refs/heads/slice/x';
    assert.ok(!on('push', '', {}, pending).includes('ruled-runs'), 'a branch push');
    where.ref = 'refs/heads/main';
    where.fork = true;
    assert.ok(!on('push', '', {}, pending).includes('ruled-runs'), 'a fork');
  } finally {
    where.ref = 'refs/heads/main';
    where.fork = false;
  }
});
