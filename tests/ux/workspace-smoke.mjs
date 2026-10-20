// The workspace UX smoke (P2-02b): the account, settings, onboarding, invitation, archive and tag screens, mounted on /privacy/ui-fixtures/workspace?screen=<name>
// against MOCKED backend responses (the app's own routes and the database REST calls are fulfilled in the browser), at 375x812, 768x1024, 1024x768 and
// 1280x800 with the real fonts. It fails on: horizontal overflow, a title narrower than its longest word, an interactive target below the law-2 floor.
// Then the behaviour contracts of the screens (a saved cadence loads and saves key-wise; a refused save puts the switch back; the team archive needs a reason and
// names its scope; a refused tag apply says so; decline acts on the invitation row), and the FIXTURE PARITY: /settings and /profile are signed-in routes the
// parity job cannot capture without credentials, so the real screens are rendered here and compared with tests/parity/baseline by the parity gate's own comparer.
//
// Usage: node tests/ux/workspace-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { readFileSync } from 'node:fs';

import { compareRecord } from '../parity/compare.mjs';

import { checkClientReads, SHELL_READS } from './client-sweep.mjs';
import { chromium, open as openPage, parityReady, smoke, summarise, until, VIEWPORTS, WIDTHS } from './harness.mjs';
import { measurePage } from './measure.mjs';
import { scopeBaseline } from './shell-filter.mjs';

const SCREENS = ['account', 'account-members', 'settings', 'landing', 'wizard', 'invitation', 'workspace'];
const run = smoke('workspace-smoke');
const { base, fail, check, must } = run;

// ── the mocked backend ───────────────────────────────────────────────────────
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
const DAY = '2026-04-04T00:00:00Z';
const SECTORS = ['fine-art', 'live-events', 'luxury-goods', 'film-tv', 'automotive', 'humanitarian'];
const STORED = {
  workspace_settings: {
    home_sections: {},
    default_export_format: 'html',
    alert_config: { priorities: ['CRITICAL', 'HIGH'], briefingCadence: 'weekly', briefingDay: 'monday', briefingTime: '08:00' },
    default_filters: { defaultSort: 'next-date' },
    profile: { roles: ['freight operator'], org_roles: ['freight_forwarder'], org_size: { headcount_band: null, revenue_band: null, shipment_volume_band: null } },
    sector_profile: SECTORS,
  },
  profiles: { full_name: null, bio: null, avatar_url: null, jurisdiction_overrides: [], transport_mode_overrides: [], verifier_status: 'none', verifier_since: null, created_at: DAY },
  notification_preferences: { enabled: true, on_mention: true, on_reply_in_my_threads: true, on_new_post_in_joined_groups: false, on_invite: true, channels: ['in_app'] },
};
const IDENTITY = { user: { id: 'u-1', email: 'smoke@example.invalid' }, orgId: 'o-1', orgName: 'Dietl / Rockit', role: 'owner', sectors: [], workspaceSectors: SECTORS, isPlatformAdmin: false };
const ORG = { org: { id: 'o-1', name: 'Dietl / Rockit', slug: 'dietl-rockit', plan: 'pilot', created_at: DAY }, caller_role: 'owner', owner: { user_id: 'u-1', display_name: 'Smoke', owner_since: DAY }, member_count: 2 };
const MEMBERS = [
  { id: 'm-1', user_id: 'u-1', role: 'owner', joined_at: DAY, display_name: 'Smoke Owner' },
  { id: 'm-2', user_id: 'u-2', role: 'member', joined_at: DAY, display_name: 'Pat Lee' },
];
const INVITE = { id: 'i-1', org_name: 'Acme Freight', org_slug: 'acme', proposed_role: 'member', status: 'pending', created_at: DAY, expires_at: '2026-12-01T00:00:00Z', token_last4: 'abcd' };
const IMPACT = { title: 'FuelEU Maritime', isCritical: true, canArchiveWorkspace: true, watcherCount: 2, watcherNames: ['Pat Lee', 'Sam Ito'], onTeamWatchlist: true, ownerName: 'Pat Lee' };
const TAGS = {
  tags: [
    { id: 't1', orgId: 'o-1', name: 'Audit 2026', itemCount: 4, createdAt: DAY },
    { id: 't2', orgId: 'o-1', name: 'Q4 prep', itemCount: 1, createdAt: DAY },
  ],
  appliedTagIds: ['t1'],
  applications: [{ tagId: 't1', appliedBy: 'u-2', appliedByName: 'Pat Lee', appliedAt: '2026-09-03T00:00:00Z' }],
};

async function install(page, state) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  await page.route('**/api/**', (route) => {
    const { pathname: p } = new URL(route.request().url());
    const m = route.request().method();
    state.calls.push(`${m} ${p}`);
    if (p === '/api/auth/identity') return json(route, IDENTITY);
    if (p === '/api/orgs/o-1' && m === 'GET') return json(route, ORG);
    if (p === '/api/orgs/o-1/members') return json(route, { members: MEMBERS, caller_role: 'owner' });
    if (p === '/api/orgs/o-1/invitations') return json(route, { invitations: [] });
    if (p === '/api/invitations/mine') return json(route, { invitations: [INVITE] });
    if (/^\/api\/invitations\/mine\/i-1\/(accept|decline)$/.test(p)) return json(route, { ok: true });
    if (/^\/api\/invitations\/a{64}$/.test(p)) return json(route, { invitation: { org_name: 'Acme Freight', invited_email: 'smoke@example.invalid', proposed_role: 'member', status: 'pending', created_at: DAY, expires_at: '2026-12-01T00:00:00Z', is_expired: false } });
    if (p === '/api/workspace/archive-impact') return json(route, IMPACT);
    if (p === '/api/workspace/tags' && m === 'GET') return json(route, TAGS);
    if (/^\/api\/workspace\/tags\/[^/]+\/items$/.test(p)) return state.refuseTags ? json(route, { error: 'Your role cannot change tags.' }, 403) : json(route, { success: true });
    return json(route, { error: `unmocked ${m} ${p}` }, 404);
  });
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const table = pathname.split('/rest/v1/')[1].split('/')[0];
    const single = /vnd\.pgrst\.object/.test(req.headers().accept ?? '');
    state.rest.push({ m, table, rpc: table === 'rpc' ? pathname.split('/rpc/')[1] : null, body: m === 'GET' ? null : req.postDataJSON() });
    if (m === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '0-0/2' }, body: '' });
    if (m !== 'GET' && state.failWrites) return json(route, { message: 'boom', code: 'XX000' }, 500);
    if (table === 'rpc') {
      const body = req.postDataJSON();
      if (pathname.endsWith('/patch_workspace_settings')) return json(route, { ...STORED.workspace_settings[body.p_column], ...body.p_patch });
      if (pathname.endsWith('/request_verification')) return json(route, 'pending');
      return json(route, null);
    }
    if (m === 'GET') return json(route, single ? STORED[table] : [STORED[table]]);
    return /return=representation/.test(req.headers().prefer ?? '') ? json(route, [{ org_id: 'o-1' }]) : route.fulfill({ status: 204, headers: CORS });
  });
}

// ── the screens ──────────────────────────────────────────────────────────────
const url = (screen) => `${base}/privacy/ui-fixtures/workspace?screen=${screen}`;
async function open(browser, screen, viewport, state = { calls: [], rest: [] }) {
  const opened = await openPage(browser, url(screen), viewport, { prepare: (page) => install(page, state) });
  return { ...opened, state };
}

const browser = await chromium.launch();
try {
  // Law 2, overflow and titles at four widths, on every screen.
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const where = `${viewport.join('x')} ${screen}`;
      await check(where, async () => {
        const session = await open(browser, screen, viewport);
        try {
          if (screen === 'wizard') await session.page.getByRole('button', { name: 'Air' }).waitFor();
          else if (screen === 'settings') await session.page.getByRole('switch', { name: 'Show Band tiles' }).waitFor();
          for (const o of await measurePage(session.page, { rows: false })) fail(where, o);
          for (const e of session.errors) fail(where, `page error: ${e}`);
        } finally {
          await session.ctx.close();
        }
      });
    }
  }

  // Each behaviour is its own session, so one failing assertion never hides another.
  const session = async (screen, run) => {
    const s = await open(browser, screen, [1280, 800]);
    try {
      await run(s);
    } finally {
      await s.ctx.close();
    }
  };

  await check('settings: the saved cadence loads and saves through the one writer, key-wise (B-0665, B-0186)', () =>
    session('settings', async ({ page, state }) => {
      const weekly = page.getByRole('radio', { name: 'Weekly', exact: true });
      await weekly.waitFor();
      must((await weekly.getAttribute('aria-checked')) === 'true', 'the saved weekly cadence did not load');
      must((await page.getByLabel('Briefing time').inputValue()) === '08:00', 'the saved time did not load');
      await page.getByRole('radio', { name: 'Daily', exact: true }).click();
      await page.getByRole('button', { name: 'Save schedule' }).click();
      await page.getByText('Saved to Dietl / Rockit.').waitFor();
      const call = state.rest.find((r) => r.rpc === 'patch_workspace_settings' && r.body.p_column === 'alert_config');
      must(call && call.body.p_patch.briefingCadence === 'daily', 'the schedule was not written through patch_workspace_settings');
      must(!('priorities' in call.body.p_patch), 'the schedule save carried a key it does not own');
    }),
  );

  await check('settings: the organisation profile and the freight sectors are two writers of their own keys and columns (INV-168)', () =>
    session('settings', async ({ page, state }) => {
      await page.getByRole('button', { name: 'Shipper' }).click();
      await page.getByRole('button', { name: 'Save organisation profile' }).click();
      await page.getByText('Saved to Dietl / Rockit.').waitFor();
      const profile = state.rest.find((r) => r.rpc === 'patch_workspace_settings' && r.body.p_column === 'profile');
      must(profile && JSON.stringify(Object.keys(profile.body.p_patch).sort()) === JSON.stringify(['org_roles', 'org_size']), 'the organisation profile patch is not exactly its two keys');
      await page.getByRole('button', { name: 'Live Events & Touring' }).click();
      await until(() => state.rest.some((r) => r.m === 'PATCH' && r.table === 'workspace_settings' && Array.isArray(r.body.sector_profile)), 'the freight sectors card wrote sector_profile', 8000);
    }),
  );

  await check('settings: a notification switch goes back when its save is refused, and says why (A2-part6 row 79)', () =>
    session('settings', async ({ page, state }) => {
      const sw = page.getByRole('switch', { name: 'Someone @mentions you' });
      await sw.waitFor();
      must((await sw.getAttribute('aria-checked')) === 'true', 'the mention switch did not start on');
      state.failWrites = true;
      await sw.click();
      await page.getByText(/switch is back where it was/).waitFor();
      must((await sw.getAttribute('aria-checked')) === 'true', 'the switch stayed flipped after a refused save');
    }),
  );

  await check('archive dialog: the team scope needs a reason, names who is told and the scope; Esc returns focus (INV-165)', () =>
    session('workspace', async ({ page }) => {
      await page.locator('#fx-archive').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(/My whole team/).check();
      await dialog.getByText(/CRITICAL/).waitFor();
      await dialog.getByText(/Pat Lee, Sam Ito/).waitFor();
      const submit = dialog.getByRole('button', { name: 'Archive for the team' });
      must(await submit.isDisabled(), 'the team archive could be submitted without a reason');
      await dialog.getByLabel(/Reason/).selectOption('superseded');
      must(await submit.isEnabled(), 'the team archive stayed disabled with a reason');
      await page.keyboard.press('Escape');
      must((await page.locator('[role=dialog]').count()) === 0, 'Esc did not close the dialog');
      must(await page.evaluate(() => document.activeElement?.id === 'fx-archive'), 'focus did not return to the opener');
    }),
  );

  await check('tag popover: who applied each tag is shown, and a refused apply says so (B-0215)', () =>
    session('workspace', async ({ page, state }) => {
      await page.getByText('applied by Pat Lee on 3 Sep 2026').first().waitFor();
      state.refuseTags = true;
      await page.getByRole('option', { name: /Q4 prep/ }).click();
      await page.getByRole('alert').filter({ hasText: 'Your role cannot change tags.' }).waitFor();
    }),
  );

  await check('landing: Decline acts on the invitation row (migration 0028) and the row goes', () =>
    session('landing', async ({ page, state }) => {
      await page.getByRole('button', { name: 'Decline' }).click();
      await page.getByText(/No pending invitations/).waitFor();
      must(state.calls.includes('POST /api/invitations/mine/i-1/decline'), 'Decline did not call the by-id route');
    }),
  );

  await check('wizard: each step saves what it owns and the last ends set up', () =>
    session('wizard', async ({ page, state }) => {
      await page.getByRole('button', { name: 'Air' }).click();
      await page.getByRole('button', { name: 'United States' }).click();
      await page.getByRole('button', { name: /Continue/ }).click();
      await page.getByRole('heading', { name: 'Which sectors do you watch?' }).waitFor();
      must(state.rest.some((r) => r.m === 'PATCH' && r.table === 'profiles' && r.body.transport_mode_overrides?.[0] === 'air'), 'step 2 did not save the modes on the profile');
      await page.getByRole('button', { name: 'Fine Art & Museum Logistics' }).click();
      await page.getByRole('button', { name: /Continue/ }).click();
      await page.getByRole('button', { name: 'Save schedule' }).waitFor();
      must(state.rest.some((r) => r.table === 'notification_preferences' && r.m !== 'GET'), 'step 3 did not seed the notification defaults');
      await page.getByRole('button', { name: 'Finish' }).click();
      await page.getByRole('heading', { name: "You're set up" }).waitFor();
    }),
  );

  // ── every read the settings and account screens make after hydration (the app's routes and the database REST reads) is refused in turn and must be stated ──
  for (const [name, screen, ready] of [['settings', 'settings', 'Show Band tiles'], ['account', 'account', 'Save personal profile']]) {
    await check(`client reads ${name}`, () => checkClientReads(run, browser, { name, url: url(screen), viewport: [1280, 800], prepare: (page) => install(page, { calls: [], rest: [] }), after: (page) => page.getByRole(ready.startsWith('Show') ? 'switch' : 'button', { name: ready }).waitFor(), ignore: SHELL_READS }));
  }

  // ── fixture parity: the real /settings and /profile screens against the committed baseline ─────────────────────────
  const config = JSON.parse(readFileSync('tests/parity/approved-changes.json', 'utf8'));
  if (parityReady(run)) {
    for (const [route, screen, ready] of [['settings', 'settings', 'Show Band tiles'], ['profile', 'account', 'Save personal profile']]) {
      for (const viewport of [[1280, 900], [375, 812]]) {
        const where = `parity ${route} ${viewport.join('x')}`;
        await check(where, async () => {
          const s = await open(browser, screen, viewport);
          try {
            await s.page.getByRole(ready.startsWith('Show') ? 'switch' : 'button', { name: ready }).waitFor();
            const captured = await summarise(s.page);
            const scoped = scopeBaseline(JSON.parse(readFileSync(`tests/parity/baseline/${route}.${viewport.join('x')}.json`, 'utf8')), 'account');
            const approved = config.approved.filter((a) => a.route === route);
            const { fails } = compareRecord(route, viewport.join('x'), scoped, captured, approved, config.dataNames ?? []);
            for (const f of fails) fail(where, f);
            // Attack: the same comparison on a capture missing one baseline control, one control out of order, and a swapped heading MUST fail.
            if (viewport[0] === 1280) {
              const pick = scoped.controls.find((c) => /Save|Filter|Sector|Settings/.test(c.name)) ?? scoped.controls[0];
              const dropped = { ...captured, controls: captured.controls.filter((c) => c.name !== pick.name) };
              const swapped = { ...captured, controls: [...captured.controls].reverse() };
              const heading = { ...captured, headings: captured.headings.map((h) => (h.level === 2 ? { ...h, text: `${h.text} (changed)` } : h)) };
              if (compareRecord(route, '1280x900', scoped, dropped, approved, config.dataNames ?? []).fails.length === 0) fail(where, `attack: a removed control (${pick.name}) passed the fixture parity`);
              if (compareRecord(route, '1280x900', scoped, swapped, approved, config.dataNames ?? []).fails.length === 0) fail(where, 'attack: a reversed control order passed the fixture parity');
              if (compareRecord(route, '1280x900', scoped, heading, approved, config.dataNames ?? []).fails.length === 0) fail(where, 'attack: a changed section heading passed the fixture parity');
            }
          } finally {
            await s.ctx.close();
          }
        });
      }
    }
  }
} finally {
  await browser.close();
}

run.finish(`clean at ${WIDTHS}; behaviours and fixture parity pass`);
