// LIVE-GATE-1: the signed-in production DOM gate. INV-1 an expired or missing session makes the job red, never green; INV-2 an armed failing assertion exits 1 and an unarmed one prints and exits 0; INV-3 the table a run prints is the
// table of the assertions file (the PR body quotes a real run of scripts/ci/live-checks.mjs --only signed-in-dom). Each evaluator is tried against facts with its defect planted, so an assertion that passes a broken page is red here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runLive } from '../../scripts/ci/live-checks.mjs';
import { signedInDom } from '../../scripts/ci/live/checks.mjs';
import { EVALUATORS, formatTable, gateResults, linksOf, loadAssertions } from '../../scripts/ci/live/dom-gate.mjs';
import { storageStateOf } from '../../scripts/ci/live-session.mjs';

/** Once armed, never disarmed. A lane that arms an assertion in its own PR adds the id here in the same PR. */
const ARMED_FLOOR = ['signed-in', 'no-404'];

const row = (over = {}) => ({ title: 'Regulation (EU) 2024/1157', why: 'Sets the rules for shipments of waste across borders.', href: '/regulations/a?list=regulations', ...over });
const page = (path, facts = {}, over = {}) => ({ path, status: 200, finalUrl: `https://x.test${path}`, facts: { text: 'A page a reader sees', accountMenu: true, title: 'Regulation (EU) 2024/1157', rows: [row()], connections: [], triggers: [], radar: { links: 2, absence: false }, ...facts }, ...over });
/** Facts from a run in which every assertion passes. */
const good = () => ({
  lists: ['/', '/regulations', '/market', '/operations', '/research'].map((p) => page(p)),
  links: [{ href: '/regulations/a', from: '/', status: 200, finalUrl: 'https://x.test/regulations/a' }],
  details: [page('/regulations/a', { connections: [{ label: 'References', title: 'Another act', reason: 'Bound by shared regulation identifier' }], triggers: ['By 21 May 2027 under 2024/1157 the Commission shall adopt an act.'] })],
  scoped: { panel: 'United States grid', profile: page('/operations/us') },
});
const byId = (results, id) => results.find((r) => r.id === id);

test('the assertions file: unique ids, every one has an owner and an evaluator, and the armed floor is armed (a ratchet: never disarmed)', () => {
  const all = loadAssertions();
  assert.equal(new Set(all.map((a) => a.id)).size, all.length);
  for (const a of all) {
    assert.ok(a.owner && a.rule, a.id);
    assert.equal(typeof a.armed, 'boolean', a.id);
    assert.equal(typeof EVALUATORS[a.id], 'function', `${a.id} has an evaluator`);
  }
  assert.deepEqual(Object.keys(EVALUATORS).sort(), all.map((a) => a.id).sort(), 'an evaluator with no entry would never run');
  for (const id of ARMED_FLOOR) assert.equal(all.find((a) => a.id === id)?.armed, true, `${id} was armed and stays armed`);
});

test('every assertion passes on good facts and trips on its own planted defect', () => {
  const plant = {
    'signed-in': (f) => { f.lists[1].finalUrl = 'https://x.test/login?next=/regulations'; },
    'no-404': (f) => { f.links.push({ href: '/regulations/gone', from: '/regulations', status: 404, finalUrl: 'https://x.test/regulations/gone' }); },
    'no-raw-ids': (f) => { f.details[0].facts.text = 'Linked by pattern_shared_scenario · 0.45 to 6666d5a0-82bb-4b17-b3ef-d47e8d0b7ee3 and fuel_gap'; },
    'rows-have-why': (f) => { f.lists[2].facts.rows.push(row({ why: '' })); },
    'connections-have-reason': (f) => { f.details[0].facts.connections.push({ label: 'References', title: 'X', reason: 'shared source' }); },
    'no-pending-text': (f) => { f.details[0].facts.text = 'Narrative synthesis pending for this cluster.'; },
    'own-mandates': (f) => { f.details[0].facts.triggers.push('The Commission shall adopt an act under 2023/9999.'); },
    'scoped-grid': (f) => { f.scoped.profile.facts.text = 'Substations monitored: UK Power Networks'; },
    'radar-present': (f) => { f.lists[0].facts.radar = null; },
  };
  const clean = gateResults(good(), loadAssertions().map((a) => ({ ...a, armed: true })));
  assert.deepEqual(clean.filter((r) => r.violations.length), []);
  for (const a of loadAssertions()) {
    const f = good();
    plant[a.id](f);
    assert.ok(byId(gateResults(f, [{ ...a, armed: true }]), a.id).violations.length > 0, `${a.id} does not trip on its defect`);
  }
});

test('an own-mandates panel with a title that names no instrument number cannot show its triggers are its own; no panel passes', () => {
  const f = good();
  f.details[0].facts.title = 'Inflation Reduction Act';
  assert.equal(EVALUATORS['own-mandates'](f).length, 1);
  f.details[0].facts.triggers = [];
  assert.deepEqual(EVALUATORS['own-mandates'](f), []);
});

test('INV-2: an armed failing assertion is FAIL (red), an unarmed failing one is NOT-ARMED (printed, not red), a passing armed one is PASS', () => {
  const f = good();
  f.links.push({ href: '/regulations/gone', from: '/', status: 404, finalUrl: 'https://x.test/regulations/gone' });
  const set = (armedNoRaw, armed404) => [{ id: 'no-404', owner: 'o', armed: armed404 }, { id: 'no-raw-ids', owner: 'o', armed: armedNoRaw }, { id: 'signed-in', owner: 'o', armed: true }];
  f.details[0].facts.text = 'score · 0.45';
  const r = gateResults(f, set(false, true));
  assert.deepEqual(r.map((x) => [x.id, x.status, x.failed]), [['no-404', 'FAIL', true], ['no-raw-ids', 'NOT-ARMED', false], ['signed-in', 'PASS', false]]);
  const none = gateResults(f, set(false, false));
  assert.ok(none.every((x) => !x.failed), 'nothing armed fails nothing');
  assert.match(formatTable(none), /NOT-ARMED no-raw-ids\s+\(would FAIL, 1; owner o\)/);
});

/** A context whose pages answer from a map of path -> { finalPath, facts }; anything else ends on /login with an empty page. */
const fakeContext = (answers, headLinks = {}) => ({
  request: { get: async (url) => ({ status: () => headLinks[new URL(url).pathname] ?? 200, url: () => url, headers: () => ({}) }) },
  newPage: async () => {
    let at = '/';
    return {
      on() {},
      goto: async (url) => { at = new URL(url).pathname; return { status: () => 200 }; },
      waitForLoadState: async () => {},
      $$eval: async () => [],
      $eval: async () => { throw new Error('none'); },
      $$: async () => [],
      url: () => `https://x.test${answers[at]?.finalPath ?? '/login'}`,
      evaluate: async () => answers[at]?.facts ?? { text: '', accountMenu: false, title: '', rows: [], connections: [], triggers: [], radar: null },
      close: async () => {},
    };
  },
});
const asRunner = (sessionContext) => runLive({ checks: ['signed-in-dom'], io: { base: 'https://x.test', sessionContext, bypass: {}, log: () => {} }, phase: 'after', record: null, env: {}, log: () => {} });

test('INV-1: a missing session file and an empty or expired storage state each make the check red; a live session with the armed assertions passing is green', async () => {
  const missing = await asRunner(async () => { throw new Error('no readable session file at scripts/tmp/live-session.json'); });
  assert.equal(missing[0].failed, 1, 'a missing session is a failure, never a skip');
  const empty = await asRunner(async () => fakeContext({}));
  assert.ok(empty[0].failed >= 1, 'an empty storage state ends every page on /login: the armed signed-in assertion fails');
  const findings = await signedInDom({ io: { base: 'https://x.test', sessionContext: async () => fakeContext({}), bypass: {}, log: () => {} } });
  assert.ok(findings.some((x) => x.severity === 'fail' && x.url === 'signed-in'), 'the failing assertion is named');
  const signed = (p) => ({ finalPath: p, facts: { text: 'A reader sees', accountMenu: true, title: 'Title', rows: [{ title: 'T', why: 'w', href: '/regulations/a' }], connections: [], triggers: [], radar: null } });
  const live = await asRunner(async () => fakeContext({ '/': signed('/'), '/regulations': signed('/regulations'), '/market': signed('/market'), '/operations': signed('/operations'), '/research': signed('/research'), '/regulations/a': signed('/regulations/a') }));
  assert.equal(live[0].failed, 0, 'a signed-in run whose armed assertions pass is green; the unarmed ones only warn');
  assert.ok(live[0].warnings > 0, 'the unarmed assertions that would fail are printed as warnings');
  const gone = await asRunner(async () => fakeContext({ '/': signed('/'), '/regulations': signed('/regulations'), '/market': signed('/market'), '/operations': signed('/operations'), '/research': signed('/research') }, { '/regulations/a': 404 }));
  assert.equal(gone[0].failed, 1, 'a 404 detail link is an armed failure');
});

test('an assertion over pages that were never read does not pass vacuously', () => {
  const f = good();
  f.links = [];
  assert.equal(EVALUATORS['no-404'](f).length, 1, 'no detail link found is a violation');
  f.lists[1] = { path: '/regulations', status: 200, finalUrl: 'https://x.test/login', facts: { ...f.lists[1].facts, rows: [] } };
  assert.ok(EVALUATORS['rows-have-why'](f).some((l) => /not read/.test(l)));
  f.details = [];
  for (const id of ['no-raw-ids', 'connections-have-reason', 'no-pending-text', 'own-mandates']) assert.ok(EVALUATORS[id](f).some((l) => /no detail page was read|not read/.test(l)), id);
});

test('INV-3: the printed table has one line per assertion of the file, in file order', () => {
  const all = loadAssertions();
  const lines = formatTable(gateResults(good())).split('\n').filter((l) => /^ {2}(PASS|FAIL|NOT-ARMED) /.test(l));
  assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)[1]), all.map((a) => a.id));
});

test('linksOf lists each detail path once, whatever its query', () => {
  const lists = [page('/', { rows: [row({ href: '/regulations/a?list=x&pos=1' })] }), page('/regulations', { rows: [row({ href: '/regulations/a?list=regulations' }), row({ href: '/regulations/b' }), row({ href: null })] })];
  assert.deepEqual(linksOf(lists).map((l) => [l.href.split('?')[0], l.from]), [['/regulations/a', '/'], ['/regulations/b', '/regulations']]);
});

test('the session minter: cookies are scoped to the target host, secure only on https; with a name unset it skips on a workstation and fails in CI naming the names', () => {
  const state = storageStateOf([{ name: 'sb-x-auth-token', value: 'v', maxAge: 100 }], 'https://carosledge.com', 1000);
  assert.deepEqual([state.cookies[0].domain, state.cookies[0].secure, state.cookies[0].expires, state.cookies[0].sameSite], ['carosledge.com', true, 1100, 'Lax']);
  assert.equal(storageStateOf([{ name: 'a', value: 'b' }], 'http://localhost:3000').cookies[0].secure, false);
  const bare = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const run = (extra) => spawnSync(process.execPath, ['scripts/ci/live-session.mjs', '--out', 'scripts/tmp/never-written.json'], { env: { ...bare, ...extra }, encoding: 'utf8' });
  assert.equal(run({}).status, 2);
  const ci = run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' });
  assert.equal(ci.status, 1);
  assert.match(ci.stdout, /missing \(exit 1\): .*LIVE_ADMIN_EMAIL/);
  assert.doesNotMatch(ci.stdout + ci.stderr, /eyJ|sb_secret/);
});

test('the live job mints the session before it runs the live checks, and nothing in the job lets a missing session pass', () => {
  const yml = readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r', '');
  const live = yml.slice(yml.indexOf('\n  live:\n'), yml.indexOf('\n  baseline:'));
  const mint = live.indexOf('node scripts/ci/live-session.mjs --base "$LIVE_BASE_URL"');
  const checks = live.indexOf('node scripts/ci/live-checks.mjs');
  assert.ok(mint > 0 && checks > mint, 'the minting step comes first');
  assert.doesNotMatch(live, /continue-on-error|\|\| true|if: .*session/, 'no step swallows a failure or skips on a session');
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'LIVE_ADMIN_EMAIL']) assert.match(live, new RegExp(`${name}: [$][{][{]`), `${name} reaches the job from a secret`);
});
