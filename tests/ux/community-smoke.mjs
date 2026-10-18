// The Community UX smoke (P2-16): /community, /community/browse, /community/[slug], /community/moderation and /community/profile (and the directory and discover pages), mounted on /privacy/ui-fixtures/community?screen=<name>
// from fixed data with MOCKED responses for the routes the screens call, at 375x812 and 1440x900 with the real fonts. It fails on: horizontal overflow, a title narrower than its longest word, an interactive target below
// the law-2 floor. Then the behaviour contracts: an invitation is answered from /community; a failed star, mute or moderation action is SAID in the server's sentence and the control goes back; the composer needs an
// entity before it posts; the members list carries the no-direct-messaging statement; a profile save sends the allowlist only; with every read failed (?state=failed) each part says so with Retry and nothing shows a zero.
// Then the FIXTURE PARITY: /community is a signed-in route the parity job cannot capture without credentials, so the real screen is rendered here and compared with tests/parity/baseline by the gate's own comparer.
//
// Usage: node tests/ux/community-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { readFileSync } from 'node:fs';

import { chromium } from 'playwright';

import { compareRecord } from '../parity/compare.mjs';
import { domSummary } from '../parity/capture.mjs';

import { measure } from './measure.mjs';

const VIEWPORTS = [
  [375, 812],
  [1440, 900],
];
const SCREENS = ['rooms', 'group', 'browse', 'directory', 'discover', 'moderation', 'profile'];
const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base.startsWith('--')) throw new Error('usage: community-smoke.mjs --base <origin>');

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const ensure = (cond, what) => {
  if (!cond) throw new Error(what);
};

// ── the mocked backend ───────────────────────────────────────────────────────
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHOR = { userId: null, name: 'Ada Fixture', company: 'Fixture Freight', headshotUrl: null, orgType: 'forwarder', role: 'Operations', sector: 'fine-art', region: 'EU', verified: true, anonymous: false };
const POST = { id: ID(901), group_id: ID(101), parent_post_id: null, title: 'Who has filed the first reporting window', body: 'We are about to file and want to compare notes on the evidence the authority asked for.', created_at: '2026-10-14T10:00:00Z', last_reply_at: null, reply_count: 0, signed_off_at: null, author: AUTHOR };
const REPORT = { id: ID(801), target_kind: 'post', target_id: ID(901), is_mine: false, can_review: true, group_name: 'Fine art crating', reason: 'spam', body: null, action: null, notes: null, status: 'open', created_at: '2026-10-15T09:00:00Z', resolved_at: null, post: { id: ID(901), group_id: ID(101), title: POST.title, excerpt: POST.body, created_at: POST.created_at } };
const PROFILE = { orgType: 'forwarder', role: 'Operations', sector: 'fine-art', region: 'EU', verified: false, verifiedAt: null, verificationMethod: null, defaultAnonymous: false };

async function install(page, state) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const m = req.method();
    const body = m === 'GET' || m === 'HEAD' ? null : (req.postDataJSON?.() ?? null);
    state.calls.push({ m, p, q: u.search, body });
    if (p === '/api/community/notifications/counts') return json(route, { groups: [], total_unread: 0 });
    if (p === '/api/community/notifications') return json(route, { notifications: [], total_matching: 0, unread_count: 0, next_cursor: null });
    if (/^\/api\/community\/invitations\/[^/]+\/(accept|decline)$/.test(p)) return state.refuse.invitation ? json(route, { error: 'This invitation is already accepted' }, 409) : json(route, { ok: true, group_id: ID(104) });
    if (/^\/api\/community\/groups\/[^/]+\/star$/.test(p)) return state.refuse.star ? json(route, { error: 'You are not a member of this group' }, 404) : json(route, { ok: true, starred: body.starred });
    if (/^\/api\/community\/groups\/[^/]+\/mute$/.test(p)) return state.refuse.mute ? json(route, { error: 'You are not a member of this group' }, 404) : json(route, { ok: true, muted: body.muted });
    if (/^\/api\/community\/groups\/[^/]+\/members$/.test(p)) return json(route, { members: [{ role: 'admin', joined_at: '2026-09-01T00:00:00Z', name: 'Smoke Member', headshot_url: null, anonymous: false, is_self: true }, { role: 'member', joined_at: '2026-09-02T00:00:00Z', name: null, headshot_url: null, anonymous: true, is_self: false }], truncated: false, identity_failed: false });
    if (p === '/api/community/posts' && m === 'GET') return json(route, { posts: [POST], next_cursor: null, identity_failed: false });
    if (p === '/api/community/entities') return json(route, { entities: [{ entity_id: 'cl:jurisdiction:aaaaaaaaaaaaaaaa', kind: 'jurisdiction', canonical_name: 'European Union' }] });
    if (p === '/api/community/moderation/reports' && m === 'GET') return state.refuse.reports ? json(route, { error: 'The reports are unavailable.' }, 503) : json(route, { reports: [REPORT], next_cursor: null });
    if (/^\/api\/community\/moderation\/reports\/[^/]+$/.test(p)) return state.refuse.act ? json(route, { error: 'Moderator or platform admin access required' }, 403) : json(route, { ok: true, report_id: REPORT.id, status: 'resolved', action: body.action, notified: true });
    if (p === '/api/community/profile' && m === 'GET') return state.refuse.profile ? json(route, { error: 'The profile is unavailable.' }, 503) : json(route, { profile: PROFILE });
    if (p === '/api/community/profile' && m === 'PUT') return json(route, { profile: { ...PROFILE, ...{ orgType: body.org_type } } });
    return json(route, { error: `unmocked ${m} ${p}` }, 404);
  });
}

const url = (screen, query = '') => `${base}/privacy/ui-fixtures/community?screen=${screen}${query}`;
async function open(browser, screen, [w, h], { query = '', refuse = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const state = { calls: [], refuse: { ...refuse } };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await install(page, state);
  const res = await page.goto(url(screen, query), { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) throw new Error(`fixture page answered ${res?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return { ctx, page, errors, state };
}

const browser = await chromium.launch();
try {
  // Law 2, overflow and titles, on every screen, healthy and with every read failed.
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      for (const query of ['', '&state=failed']) {
        const where = `${viewport.join('x')} ${screen}${query ? ' failed' : ''}`;
        let s;
        try {
          s = await open(browser, screen, viewport, { query, refuse: query ? { reports: true, profile: true } : {} });
          for (const o of await s.page.evaluate(measure, { rows: false })) fail(where, o);
          for (const e of s.errors) fail(where, `page error: ${e}`);
        } catch (e) {
          fail(where, e.message.split('\n')[0]);
        } finally {
          await s?.ctx.close();
        }
      }
    }
  }
  // The threads state of the rooms (the rooms with discussions, a sign-off pending, a thread signed off).
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.join('x')} rooms threads`;
    let s;
    try {
      s = await open(browser, 'rooms', viewport, { query: '&state=threads' });
      for (const o of await s.page.evaluate(measure, { rows: false })) fail(where, o);
      for (const e of s.errors) fail(where, `page error: ${e}`);
    } catch (e) {
      fail(where, e.message.split('\n')[0]);
    } finally {
      await s?.ctx.close();
    }
  }

  const check = async (name, run) => {
    try {
      await run();
    } catch (e) {
      fail(name, e.message.split('\n')[0]);
    }
  };
  const bodyText = (page) => page.evaluate(() => document.body.innerText);

  await check('invitation is answered from /community', async () => {
    const s = await open(browser, 'rooms', [1440, 900]);
    ensure(/Pending invitations \(1\)/i.test(await bodyText(s.page)), 'the pending invitation panel is not on the page');
    await s.page.getByRole('button', { name: 'Accept' }).click();
    await s.page.getByText(/You joined/).waitFor();
    ensure(s.state.calls.some((c) => c.m === 'POST' && /\/invitations\/[^/]+\/accept$/.test(c.p)), 'accept did not reach the route');
    await s.ctx.close();
    const r = await open(browser, 'rooms', [1440, 900], { refuse: { invitation: true } });
    await r.page.getByRole('button', { name: 'Decline' }).click();
    await r.page.getByText('This invitation is already accepted').first().waitFor();
    await r.ctx.close();
  });

  await check('a refused star or mute is said and put back', async () => {
    const s = await open(browser, 'group', [1440, 900], { refuse: { star: true, mute: true } });
    const star = s.page.getByRole('button', { name: /^Starred$/ });
    ensure((await star.getAttribute('aria-pressed')) === 'true', 'the fixture group should start starred');
    await star.click();
    await s.page.getByText('You are not a member of this group').first().waitFor();
    ensure((await s.page.getByRole('button', { name: /^Starred$/ }).getAttribute('aria-pressed')) === 'true', 'the star was not put back after the refusal');
    await s.page.getByRole('button', { name: /^Mute$/ }).click();
    await s.page.waitForTimeout(300);
    ensure((await s.page.getByRole('button', { name: /^Mute$/ }).getAttribute('aria-pressed')) === 'false', 'the mute was not put back after the refusal');
    ensure(s.state.calls.filter((c) => c.m === 'PATCH').length === 2, 'both changes should have been asked of the routes');
    await s.ctx.close();
  });

  await check('the members list says there is no direct messaging', async () => {
    const s = await open(browser, 'group', [1440, 900]);
    await s.page.getByRole('button', { name: 'Members' }).click();
    await s.page.getByRole('dialog').getByText(/No direct messaging/).waitFor();
    ensure(!(await s.page.getByRole('dialog').getByRole('link', { name: /message|contact/i }).count()), 'a member row offers to message or contact');
    await s.ctx.close();
  });

  await check('the composer needs an entity before it posts', async () => {
    const s = await open(browser, 'group', [1440, 900]);
    await s.page.getByLabel('Start a post').fill('A title');
    await s.page.getByLabel('Post body').fill('Some text');
    ensure(await s.page.getByRole('button', { name: 'Post', exact: true }).isDisabled(), 'the Post button is enabled with no entity bound');
    await s.page.locator('#entity-picker-search').fill('euro');
    await s.page.getByRole('button', { name: /European Union/ }).first().click();
    ensure(await s.page.getByRole('button', { name: 'Post', exact: true }).isEnabled(), 'the Post button stays disabled with an entity bound');
    await s.ctx.close();
  });

  await check('a refused moderation action is said, and the report stays', async () => {
    const s = await open(browser, 'moderation', [1440, 900], { refuse: { act: true } });
    await s.page.getByRole('button', { name: 'Take action' }).first().click();
    await s.page.getByRole('button', { name: 'Dismiss', exact: true }).first().waitFor();
    await s.page.getByRole('button', { name: 'Dismiss', exact: true }).first().click();
    await s.page.getByText('Moderator or platform admin access required').first().waitFor();
    ensure(await s.page.getByRole('button', { name: 'Dismiss', exact: true }).first().isVisible(), 'the report left the queue after a refused action');
    await s.ctx.close();
  });

  await check('a failed report read says so with Retry, never an empty queue', async () => {
    const s = await open(browser, 'moderation', [1440, 900], { refuse: { reports: true } });
    await s.page.getByRole('button', { name: 'Retry' }).waitFor();
    ensure(!/No reports|nothing to review/i.test(await bodyText(s.page)), 'a failed read drew an empty queue');
    await s.ctx.close();
  });

  await check('a profile save sends the allowlist only', async () => {
    const s = await open(browser, 'profile', [1440, 900]);
    await s.page.getByRole('button', { name: /^Save/ }).first().click();
    await s.page.waitForTimeout(300);
    const put = s.state.calls.find((c) => c.m === 'PUT');
    ensure(put, 'the profile was not saved');
    ensure(Object.keys(put.body).every((k) => ['org_type', 'role', 'sector', 'region', 'default_anonymous'].includes(k)), `the save carries ${Object.keys(put.body)}`);
    await s.ctx.close();
  });

  await check('the rooms with every read failed say so with Retry, with a dash and not a zero', async () => {
    const s = await open(browser, 'rooms', [1440, 900], { query: '&state=failed' });
    await s.page.getByRole('button', { name: 'Retry' }).first().waitFor();
    const text = await bodyText(s.page);
    ensure(/could not be loaded/i.test(text), 'no stated failure');
    ensure(!/no discussions yet/i.test(text), 'a failed thread read drew "no discussions yet"');
    ensure(/· — active item/.test(text.replace(/\s+/g, ' ')), 'the header count is not a dash');
    await s.ctx.close();
  });

  // ── fixture parity: the real /community screen against the committed baseline ─────────────────────────────────
  const config = JSON.parse(readFileSync('tests/parity/approved-changes.json', 'utf8'));
  const shell = [...config.frameControls, '^combobox:Search or ask', '^button:Ask$'].map((re) => new RegExp(re));
  for (const viewport of [[1280, 900], [375, 812]]) {
    const where = `parity community ${viewport.join('x')}`;
    let s;
    try {
      s = await open(browser, 'rooms', viewport);
      await s.page.getByRole('button', { name: 'Start a discussion' }).first().waitFor();
      const captured = await s.page.evaluate(domSummary, 20);
      const baseline = JSON.parse(readFileSync(`tests/parity/baseline/community.${viewport.join('x')}.json`, 'utf8'));
      // The shell supplies the platform nav, the mobile top bar and the one <main>: the baseline is cut to what is inside the page (from the first main on; from the page's own h1 on).
      const mainAt = baseline.landmarks.findIndex((l) => l.role === 'main');
      const h1At = baseline.headings.map((h) => h.level).lastIndexOf(1);
      const scoped = {
        ...baseline,
        rows: { items: [] },
        landmarks: baseline.landmarks.slice(mainAt + 1),
        headings: baseline.headings.slice(h1At),
        controls: baseline.controls.filter((c) => !shell.some((re) => re.test(`${c.role}:${c.name.replace(/(?<=[A-Za-z])[\d,]+$/, '')}`))),
      };
      const approved = config.approved.filter((a) => a.route === 'community');
      const { fails } = compareRecord('community', viewport.join('x'), scoped, captured, approved);
      for (const f of fails) fail(where, f);
      if (viewport[0] === 1280) {
        // Attack: the same comparison on a capture missing one baseline control, and one with the controls reversed, MUST fail.
        const pick = scoped.controls.find((c) => /Start a discussion|Join room|Post/.test(c.name)) ?? scoped.controls[0];
        const dropped = { ...captured, controls: captured.controls.filter((c) => c.name !== pick.name) };
        const swapped = { ...captured, controls: [...captured.controls].reverse() };
        if (compareRecord('community', '1280x900', scoped, dropped, approved).fails.length === 0) fail(where, `attack: a removed control (${pick.name}) passed the fixture parity`);
        if (compareRecord('community', '1280x900', scoped, swapped, approved).fails.length === 0) fail(where, 'attack: a reversed control order passed the fixture parity');
      }
    } catch (e) {
      fail(where, e.message.split('\n')[0]);
    } finally {
      await s?.ctx.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(`community-smoke: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('community-smoke: clean at 375x812 and 1440x900; behaviours and fixture parity pass');
