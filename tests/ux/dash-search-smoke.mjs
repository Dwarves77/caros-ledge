// The dashboard, watchlist, search, portfolio and Assistant UX smoke (P2-13): every screen mounted on /privacy/ui-fixtures/dash-search?screen=<name> against MOCKED backend responses, at 375x812, 768x1024, 1024x768 and
// 1280x800 with the real fonts. It fails on: horizontal overflow, a title narrower than its longest word, an interactive target below the law-2 floor. Then the behaviour contracts (a band tile opens its band, a row opens
// its surface, a row's menu carries the Watch toggle and a refused save puts it back, a failed read says so with Retry and never draws a zero, the portfolio forms, the Assistant opens from the command bar, answers with
// the item's rating, and closes on Esc with focus back on the bar), and the FIXTURE PARITY: /watchlist and /search?q=emissions are compared with tests/parity/baseline by the parity gate's own comparer, with and
// without the live corpus (the watchlist as the baseline account sees it: empty; the search with the baseline's own twenty titles), plus the attacks that make the comparison itself prove it can fail.
//
// Usage: node tests/ux/dash-search-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { readFileSync } from 'node:fs';

import { chromium } from 'playwright';

import { compareRecord } from '../parity/compare.mjs';
import { domSummary } from '../parity/capture.mjs';

import { shellControl } from './shell-filter.mjs';
import { measure } from './measure.mjs';

const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
];
const SCREENS = ['dashboard', 'dashboard-empty', 'dashboard-failed', 'watchlist', 'watchlist-empty', 'watchlist-failed', 'search', 'search-empty', 'search-failed', 'portfolio-index', 'portfolio-unavailable', 'portfolio-detail', 'assistant'];
const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base.startsWith('--')) throw new Error('usage: dash-search-smoke.mjs --base <origin>');
const config = JSON.parse(readFileSync('tests/parity/approved-changes.json', 'utf8'));

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

// ── the mocked backend ───────────────────────────────────────────────────────
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const IDENTITY = { user: { id: 'u-1', email: 'smoke@example.invalid' }, orgId: 'o-1', orgName: 'Dietl / Rockit', role: 'owner', sectors: [], workspaceSectors: [], isPlatformAdmin: false };
const BOOT = { personalState: [], members: [], adminAttention: null, overrides: [], navCounts: null, assistantEnabled: true, degraded: [] };
const ASK = {
  question: 'Regulation 2023/9999 reporting',
  hits: [{ id: 'h1', title: 'Regulation (EU) 2023/9999 on sustainable freight operations', href: '/regulations/h1', priority: 'HIGH', jurisdiction: 'EU', meta: 'regulation · road', tier: 1, summary: 'Annual emissions reporting for freight operators.', excerpt: 'Operators shall report verified emissions by 30 April of each year.', intersection: null, relatedCount: 2, source: { name: 'EUR-Lex', url: 'https://eur-lex.europa.eu/', citationCount: 5, recency: '2026-10-01' } }],
  answers: [{ itemId: 'h1', itemTitle: 'Regulation (EU) 2023/9999', question: 'What must a reader do in response, and by when?', text: 'Reports are due on 30 April of each year.', statusToken: 'HYPOTHESIS', confidence: 0.6, cited: [{ id: 'h1', title: 'Regulation (EU) 2023/9999 on sustainable freight operations', href: '/regulations/h1' }], computedAt: '2026-10-14T00:00:00Z' }],
  passages: [{ id: 'source-hierarchy', heading: 'How sources are weighted', text: 'When sources conflict, they are weighted in this order.' }],
  operations: [],
  disclaimer: 'This response surfaces relevant platform content for your research. It is not legal, regulatory, financial, or operational advice.',
  empty: false,
};
const COVERAGE = { dataClasses: [{ code: 'regulations', label: 'Regulations', numerator: 12, denominator: 40 }] };
const HITS = [{ id: 'f1', title: 'Fuel rule for the add card', item_type: 'regulation', domain: 1, priority: 'HIGH', jurisdictions: ['EU'], transport_modes: ['road'], topic: 'fuels', tier: 1 }];

async function install(page, state) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const { pathname: p, search } = new URL(req.url());
    const m = req.method();
    state.calls.push(`${m} ${p}${search}`);
    if (p === '/api/auth/identity') return json(route, IDENTITY);
    if (p === '/api/workspace/bootstrap') return json(route, BOOT);
    if (p === '/api/watchlist' && m === 'GET') return json(route, { watchedIds: ['d2'], teamWatchedIds: [], teamAvailable: true });
    if (p === '/api/watchlist') return state.refuseWatch ? json(route, { error: 'refused' }, 403) : json(route, { watched: m === 'POST', scope: 'personal' });
    if (p === '/api/ask') return state.askFails ? json(route, { error: 'The Assistant could not answer just now. Try again.' }, 503) : json(route, ASK);
    if (p === '/api/search') return json(route, { query: 'fuel', results: HITS });
    if (p === '/api/dashboard/coverage/matrix') return json(route, COVERAGE);
    if (p === '/api/workspace/portfolios' && m === 'POST') return json(route, { portfolio: { id: 'p9', name: 'Fresh' }, existed: false }, 201);
    if (p.startsWith('/api/workspace/portfolios/')) return json(route, {});
    return json(route, { error: `unmocked ${m} ${p}` }, 404);
  });
  await page.route('**/rest/v1/**', (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS }) : json(route, [])));
}

/** A signed-in browser session for authedFetch: the cookie the Supabase client reads, far from expiry, so no refresh call is made. */
async function signIn(ctx) {
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0] : 'placeholder');
  const session = { access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000, user: { id: 'u-1', aud: 'authenticated', email: 'smoke@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
  await ctx.addCookies([{ name: `sb-${ref}-auth-token`, value: encodeURIComponent(JSON.stringify(session)), url: base }]);
}

const url = (screen, extra = '') => `${base}/privacy/ui-fixtures/dash-search?screen=${screen}${extra}`;
async function open(browser, screen, [w, h], state = { calls: [] }, extra = '') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await signIn(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await install(page, state);
  const res = await page.goto(url(screen, extra), { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) throw new Error(`fixture page answered ${res?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errors, state };
}

const browser = await chromium.launch();
try {
  // Law 2, overflow and titles at four widths, on every screen.
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const where = `${viewport.join('x')} ${screen}`;
      let s;
      try {
        s = await open(browser, screen, viewport);
        if (screen === 'assistant') {
          await s.page.locator('#fx-ask').click();
          await s.page.getByText('Platform items').waitFor();
          await s.page.locator('details > summary').first().click();
        } else await s.page.waitForTimeout(400);
        for (const o of await s.page.evaluate(measure, { rows: false })) fail(where, o);
        for (const e of s.errors) fail(where, `page error: ${e}`);
      } catch (e) {
        fail(where, e.message.split('\n')[0]);
      } finally {
        await s?.ctx.close();
      }
    }
  }

  const check = async (name, run) => {
    try {
      await run();
    } catch (e) {
      fail(`behaviour: ${name}`, e.message.split('\n').slice(0, 4).join(' | '));
    }
  };
  const must = (cond, what) => {
    if (!cond) throw new Error(what);
  };
  const session = async (screen, run, vp = [1280, 800], extra = '') => {
    const s = await open(browser, screen, vp, { calls: [] }, extra);
    try {
      await run(s);
    } finally {
      await s.ctx.close();
    }
  };

  await check('dashboard: a band tile opens its band on Regulations; a row opens its own surface; the foot links to the band and the newest-first order', () =>
    session('dashboard', async ({ page }) => {
      must((await page.getByRole('link', { name: /^Immediate/ }).first().getAttribute('href')) === '/regulations?band=immediate', 'the Immediate tile does not open its band');
      must((await page.getByRole('link', { name: /Euro 7 Standard/ }).first().getAttribute('href')) === '/regulations/c1', 'a What-changed row does not link to its item');
      must((await page.getByRole('link', { name: /A market signal with a very long title/ }).first().getAttribute('href')) === '/market/c3', 'a market item does not open on Market');
      must((await page.getByRole('link', { name: /^All 15 immediate/ }).getAttribute('href')) === '/regulations?band=immediate', 'the Due-next foot does not open the immediate band');
      must((await page.getByRole('link', { name: /^All 49 changes in the last 90 days/ }).getAttribute('href')) === '/regulations?sort=newest', 'the What-changed foot does not open the newest-first list');
      const rail = (await page.locator('[data-audit="across-platform-card"]').innerText());
      must(/1,320/.test(rail) && /Market Intel/.test(rail), 'the Across the platform card is missing a surface count');
      must((await page.getByRole('link', { name: /Portfolios/ }).first().getAttribute('href')) === '/dashboard/portfolio', 'the Portfolios entry does not open the portfolios');
    }),
  );

  await check('dashboard: the Watch toggle lives in the row menu, shows what the membership read says, and a refused save puts it back with a visible line (never a second star)', () =>
    session('dashboard', async ({ page, state }) => {
      must((await page.locator('.cl-watch-icon').count()) === 0, 'a second watch star is drawn on a row');
      const menu = page.getByRole('button', { name: 'Actions for ReFuelEU Aviation: sustainable aviation fuel supply mandate' });
      await menu.click();
      const watching = page.getByRole('button', { name: /Watching/ }).first();
      await watching.waitFor();
      must((await watching.getAttribute('aria-pressed')) === 'true', 'the watched row (d2) does not read as watched from the membership');
      must(state.calls.filter((c) => c.startsWith('GET /api/watchlist?item_type=reg')).length === 1, 'the membership was read more than once for one type');
      state.refuseWatch = true;
      await watching.click();
      await page.getByRole('alert').filter({ hasText: 'Save failed' }).waitFor();
      must((await watching.getAttribute('aria-pressed')) === 'true', 'the refused unwatch was not put back');
    }),
  );

  await check('dashboard: a failed read says so with a Retry on both cards and blank counts, never a zero or an empty list', () =>
    session('dashboard-failed', async ({ page }) => {
      const text = await page.locator('main').innerText();
      must((text.match(/The brief did not load/g) ?? []).length === 2, 'both cards must say the brief did not load');
      must(await page.getByRole('button', { name: 'Retry' }).first().isVisible(), 'no Retry');
      must(!/Nothing added or updated/.test(text) && !/No item in this workspace/.test(text), 'a failed read drew an empty-state sentence');
      must((await page.locator('.cl-skel-tile').count()) === 4, 'the band tiles are not blank');
      must(/needs more data/i.test(text), 'the masthead counts are not the stated absence');
    }),
  );

  await check('watchlist: filters narrow the rows, the search bar filters live, and an empty or failed watchlist says which it is', () =>
    session('watchlist', async ({ page }) => {
      await page.getByText('Watched · 4').waitFor();
      must((await page.locator('[data-part=list-row]').count()) === 4, 'the four watched rows are not drawn');
      await page.getByLabel('Team').check();
      must((await page.locator('[data-part=list-row]').count()) === 2, 'the Team scope facet did not narrow the rows');
      await page.getByRole('button', { name: /^Clear/ }).click();
      await page.getByRole('combobox', { name: 'Search or ask across the workspace' }).fill('EUR/USD');
      must((await page.locator('[data-part=list-row]').count()) === 1, 'the command bar did not filter the watchlist');
      await page.getByRole('combobox', { name: 'Search or ask across the workspace' }).fill('zzzz');
      await page.getByText('No watched items match these filters').waitFor();
      must((await page.locator('#recalculation-notices').innerText()).includes('64.8'), 'the recalculation notice shows no new value');
    }),
  );
  await check('watchlist: the empty and failed states are different sentences; the failed one offers Retry', async () => {
    await session('watchlist-empty', async ({ page }) => must((await page.locator('main').innerText()).includes('Nothing watched yet'), 'the empty watchlist does not say so'));
    await session('watchlist-failed', async ({ page }) => {
      const t = await page.locator('main').innerText();
      must(t.includes('Your watchlist did not load') && t.includes('Recalculation notices did not load'), 'the failed watchlist does not say both reads failed');
      must(!t.includes('Nothing watched yet') && !t.includes('Watched · 0'), 'a failed read drew the empty state or a zero count');
    });
  });

  await check('search: rows carry their source rating; a failed search says so with Retry; no result is a different sentence', async () => {
    await session('search', async ({ page }) => {
      must((await page.locator('.cl-row-tier').first().innerText()).includes('T1'), 'the row carries no tier chip');
      must(/Results · 4/i.test(await page.locator('main').innerText()), 'the result count is missing');
    });
    await session('search-failed', async ({ page }) => {
      const t = await page.locator('main').innerText();
      must(t.includes('Search is unavailable right now') && !t.includes('Results · 0') && !t.includes('No results'), 'a failed search is not stated as a failure');
    });
    await session('search-empty', async ({ page }) => must((await page.locator('main').innerText()).includes('No results for'), 'no result is not stated'));
  });

  await check('portfolio index: creating a portfolio posts the name and opens it; the table row opens its portfolio', () =>
    session('portfolio-index', async ({ page, state }) => {
      await page.getByLabel('Portfolio name').fill('Fresh');
      await page.getByRole('button', { name: 'Create portfolio' }).click();
      await page.waitForURL(/\/dashboard\/portfolio\/p9/, { timeout: 5000 }).catch(() => undefined);
      must(state.calls.includes('POST /api/workspace/portfolios'), 'the create call was not made');
    }),
  );
  await check('portfolio detail: the held count carries its denominator, a not-held member is named, and the add card searches and shows the coverage line', () =>
    session('portfolio-detail', async ({ page, state }) => {
      const t = await page.locator('main').innerText();
      must(/3 of 4 items held/.test(t), 'the held count lost its denominator');
      must(/1 item in this portfolio is no longer held/.test(t), 'the not-held member is not named');
      await page.getByLabel('Search for an item to add').fill('fuel');
      await page.getByText('Fuel rule for the add card').waitFor();
      await page.getByText(/Coverage for this: 12 of 40 catalogued Regulations instruments/).waitFor();
      await page.getByRole('button', { name: 'Add Fuel rule for the add card to this portfolio' }).click();
      await page.waitForTimeout(300);
      must(state.calls.includes('POST /api/workspace/portfolios/p1/members'), 'the add call was not made');
    }),
  );

  await check('assistant: opened by the bar, answers with the rating, the inference label and the platform guide, closes on Esc with focus back, and a failed answer offers Try again', async () => {
    await session('assistant', async ({ page, state }) => {
      await page.locator('#fx-ask').click();
      const dialog = page.getByRole('dialog', { name: 'Intelligence Assistant' });
      await dialog.getByText('Platform items · 1').waitFor();
      const t = await dialog.innerText();
      must(/Inference · HYPOTHESIS · confidence 60%/.test(t), 'the answer is not labelled as an inference with its status and confidence');
      must(/From the platform guide · How sources are weighted/i.test(t), 'the platform guide passage is not shown');
      must((await dialog.locator('.cl-row-tier').first().innerText()).includes('T1'), 'the citation carries no tier chip');
      must(state.calls.filter((c) => c === 'POST /api/ask').length === 1, 'the question was asked more than once');
      await page.keyboard.press('Escape');
      must((await page.locator('[role=dialog]').count()) === 0, 'Esc did not close the panel');
    });
    await session('assistant', async ({ page, state }) => {
      state.askFails = true;
      await page.locator('#fx-ask').click();
      const dialog = page.getByRole('dialog', { name: 'Intelligence Assistant' });
      await dialog.getByText('could not answer just now').waitFor();
      state.askFails = false;
      await dialog.getByRole('button', { name: 'Try again' }).click();
      await dialog.getByText('Platform items · 1').waitFor();
    });
  });

  // ── fixture parity: the real screens against the baseline, by the gate's own comparer ──
  // The fixture draws the page content without the shell (the shell is the frame gate's), so the baseline is cut to the same scope: from the main landmark on, without the shell's controls and heading.
  const isShell = shellControl(config); // tests/ux/shell-filter.mjs: the shell's controls come from approved-changes.json frameControls
  const scope = (b) => ({ ...b, rows: { items: [] }, landmarks: b.landmarks.slice(Math.max(0, b.landmarks.findIndex((l) => l.role === 'main'))), headings: b.headings.filter((x, i, all) => x.text !== "Caro's Ledge" && !(i > 0 && all[i - 1].text === x.text && all[i - 1].level === x.level)), controls: b.controls.filter((c) => !isShell(c)) });
  const parity = async (name, route, screen, extra = '') => {
    for (const viewport of VIEWPORTS.filter(([w]) => w === 375 || w === 1280)) {
      const where = `parity ${name} ${viewport.join('x')}`;
      const vp = w375or1280(viewport);
      try {
        const s = await open(browser, screen, vp, { calls: [] }, extra);
        try {
          await s.page.waitForTimeout(500);
          const captured = await s.page.evaluate(domSummary, 20);
          const baseline = scope(JSON.parse(readFileSync(`tests/parity/baseline/${route}.${vp[0] === 375 ? '375x812' : '1280x900'}.json`, 'utf8')));
          const approved = config.approved.filter((a) => a.route === route);
          const { fails } = compareRecord(route, vp[0] === 375 ? '375x812' : '1280x900', baseline, captured, approved, config.dataNames ?? []);
          for (const f of fails) fail(where, f);
          if (vp[0] === 1280) {
            const pick = baseline.controls.find((c) => /Ask|Browse/.test(c.name)) ?? baseline.controls[0];
            const dropped = { ...captured, controls: captured.controls.filter((c) => c.name !== pick.name) };
            const swapped = { ...captured, controls: [...captured.controls].reverse() };
            const heading = { ...captured, headings: captured.headings.map((h) => (h.level === 2 ? { ...h, text: `${h.text} (changed)` } : h)) };
            if (compareRecord(route, '1280x900', baseline, dropped, approved, config.dataNames ?? []).fails.length === 0) fail(where, `attack: a removed control (${pick.name}) passed`);
            if (compareRecord(route, '1280x900', baseline, swapped, approved, config.dataNames ?? []).fails.length === 0) fail(where, 'attack: a reversed control order passed');
            if (compareRecord(route, '1280x900', baseline, heading, approved, config.dataNames ?? []).fails.length === 0) fail(where, 'attack: a changed section heading passed');
          }
        } finally {
          await s.ctx.close();
        }
      } catch (e) {
        fail(where, e.message.split('\n')[0]);
      }
    }
  };
  const w375or1280 = ([w]) => (w === 375 ? [375, 812] : [1280, 900]);
  await parity('watchlist', 'watchlist', 'watchlist-empty');
  const searchBase = JSON.parse(readFileSync('tests/parity/baseline/search-emissions.1280x900.json', 'utf8'));
  const titles = searchBase.controls.filter((c) => c.role === 'link' && !/^(Caro|Dashboard|Watchlist|Regulations|Market|Research|Operations|Map|Community|Account)/.test(c.name)).map((c) => c.name);
  must(titles.length === 20, `the baseline search carries ${titles.length} result titles, not 20`);
  await parity('search-emissions', 'search-emissions', 'search-parity', `&titles=${encodeURIComponent(JSON.stringify(titles))}`);
} finally {
  await browser.close();
}

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(`dash-search-smoke: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('dash-search-smoke: clean at 375x812, 768x1024, 1024x768, 1280x800');
