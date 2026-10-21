// The Community UX smoke (P2-16): /community, /community/browse, /community/[slug], /community/moderation and /community/profile (and the directory and discover pages), mounted on /privacy/ui-fixtures/community?screen=<name>
// from fixed data with MOCKED responses for the routes the screens call, at the four widths every smoke uses (375, 768, 1024 and 1280) with the real fonts. It fails on: horizontal overflow, a title narrower than its longest word, an interactive target below
// the law-2 floor. Then the behaviour contracts: an invitation is answered from /community; a failed star, mute or moderation action is SAID in the server's sentence and the control goes back; the composer needs an
// entity before it posts; the members list carries the no-direct-messaging statement; a profile save sends the allowlist only; with every read failed (?state=failed) each part says so with Retry and nothing shows a zero.
// Then the FIXTURE PARITY: /community is a signed-in route the parity job cannot capture without credentials, so the real screen is rendered here and compared with tests/parity/baseline by the gate's own comparer.
//
// Usage: node tests/ux/community-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { readFileSync } from 'node:fs';

import { compareRecord } from '../parity/compare.mjs';

import { chromium, open as openPage, parityReady, smoke, summarise, until, VIEWPORTS, WIDTHS } from './harness.mjs';
import { hitArea, measurePage } from './measure.mjs';
import { scopeBaseline } from './shell-filter.mjs';

const SCREENS = ['rooms', 'group', 'browse', 'directory', 'discover', 'moderation', 'profile'];
const run = smoke('community-smoke');
const { base, fail, check, must: ensure } = run;

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
async function open(browser, screen, viewport, { query = '', refuse = {} } = {}) {
  const state = { calls: [], refuse: { ...refuse } };
  const opened = await openPage(browser, url(screen, query), viewport, { prepare: (page) => install(page, state) });
  return { ...opened, state };
}

const browser = await chromium.launch();
try {
  // Law 2, overflow and titles, on every screen, healthy and with every read failed.
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      for (const query of ['', '&state=failed']) {
        const where = `${viewport.join('x')} ${screen}${query ? ' failed' : ''}`;
        await check(where, async () => {
          const s = await open(browser, screen, viewport, { query, refuse: query ? { reports: true, profile: true } : {} });
          try {
            for (const o of await measurePage(s.page, { rows: false })) fail(where, o);
            for (const e of s.errors) fail(where, `page error: ${e}`);
          } finally {
            await s.ctx.close();
          }
        });
      }
    }
  }
  // The threads state of the rooms (the rooms with discussions, a sign-off pending, a thread signed off).
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.join('x')} rooms threads`;
    await check(where, async () => {
      const s = await open(browser, 'rooms', viewport, { query: '&state=threads' });
      try {
        for (const o of await measurePage(s.page, { rows: false })) fail(where, o);
        for (const e of s.errors) fail(where, `page error: ${e}`);
      } finally {
        await s.ctx.close();
      }
    });
  }

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
    await until(() => s.state.calls.some((c) => c.m === 'PATCH' && /\/mute$/.test(c.p)), 'the mute change reached its route', 5000);
    await s.page.getByText('You are not a member of this group').first().waitFor();
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
    await until(() => s.state.calls.some((c) => c.m === 'PUT'), 'the profile save reached its route', 5000);
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
    ensure(/discussions could not be loaded/i.test(text) && !/active item/i.test(text), 'the tile failure is not stated or the header still draws an active item count');
    await s.ctx.close();
  });

  // The rooms screen makes no client read (its data arrives as props), so there is nothing to refuse there.

  // ── fixture parity: the real /community screen against the committed baseline ─────────────────────────────────
  const config = JSON.parse(readFileSync('tests/parity/approved-changes.json', 'utf8'));
  if (parityReady(run)) {
    for (const viewport of [[1280, 900], [375, 812]]) {
      const where = `parity community ${viewport.join('x')}`;
      await check(where, async () => {
        const s = await open(browser, 'rooms', viewport);
        try {
          await s.page.getByRole('button', { name: 'Start a discussion' }).first().waitFor();
          const captured = await summarise(s.page);
          // The shell supplies the platform nav, the mobile top bar and the one <main>: the baseline is cut to what is inside the page (tests/ux/shell-filter.mjs, kind 'in-main').
          const scoped = scopeBaseline(JSON.parse(readFileSync(`tests/parity/baseline/community.${viewport.join('x')}.json`, 'utf8')), 'in-main');
          const approved = config.approved.filter((a) => a.route === 'community');
          const { fails } = compareRecord('community', viewport.join('x'), scoped, captured, approved, config.dataNames ?? []);
          for (const f of fails) fail(where, f);
          if (viewport[0] === 1280) {
            // Attack: the same comparison on a capture missing one baseline control, one with the controls reversed, and one with a changed heading MUST fail.
            const pick = scoped.controls.find((c) => /Start a discussion|Join room|Post/.test(c.name)) ?? scoped.controls[0];
            const dropped = { ...captured, controls: captured.controls.filter((c) => c.name !== pick.name) };
            const swapped = { ...captured, controls: [...captured.controls].reverse() };
            const heading = { ...captured, headings: captured.headings.map((h) => (h.level === 2 ? { ...h, text: `${h.text} (changed)` } : h)) };
            if (compareRecord('community', '1280x900', scoped, dropped, approved, config.dataNames ?? []).fails.length === 0) fail(where, `attack: a removed control (${pick.name}) passed the fixture parity`);
            if (compareRecord('community', '1280x900', scoped, swapped, approved, config.dataNames ?? []).fails.length === 0) fail(where, 'attack: a reversed control order passed the fixture parity');
            if (compareRecord('community', '1280x900', scoped, heading, approved, config.dataNames ?? []).fails.length === 0) fail(where, 'attack: a changed section heading passed the fixture parity');
          }
        } finally {
          await s.ctx.close();
        }
      });
    }
  }
  // Design ruling 2026-10-18 item 40: the two prose links ("workspace invitation", "not a verifier") keep their text and line, with a 44 px hit area, at 375 and 1280.
  for (const viewport of [[375, 812], [1280, 900]]) {
    const seen = new Set();
    for (const [screen, query] of [['rooms', ''], ['rooms', '&state=threads'], ['group', '']]) {
      const where = `${viewport.join('x')} ${screen}${query} prose links`;
      await check(where, async () => {
        const s = await open(browser, screen, viewport, { query });
        try {
          for (const f of await s.page.evaluate(hitArea, '[class*="inlineLink"]')) {
            seen.add(f.label);
            if (f.hitH < 43.5) fail(where, `"${f.label}" hit area ${f.hitW}x${f.hitH}, expected at least 44 high`);
            if (f.layoutH > 28) fail(where, `"${f.label}" box grew to ${f.layoutH} px`);
          }
        } finally {
          await s.ctx.close();
        }
      });
    }
    for (const want of ['workspace invitation', 'not a verifier']) if (!seen.has(want)) fail(`${viewport.join('x')} prose links`, `the "${want}" link was not found on any screen`);
  }
} finally {
  await browser.close();
}

run.finish(`clean at ${WIDTHS}; behaviours and fixture parity pass`);
