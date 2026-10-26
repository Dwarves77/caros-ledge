// The Market UX smoke (P2-11): the Market page mounted on /privacy/ui-fixtures/market from fixed data, with MOCKED responses for the three routes the page's client parts call, at 375x812, 768x1024, 1024x768 and 1280x800 with the real
// fonts. It fails on: horizontal overflow outside a declared strip, a title narrower than its longest word, an interactive target below the law-2 floor. Then the behaviour contracts: the headline strip carries each figure's source rating, the
// policy timeline widens and narrows its scope, a failed notices read says so and Retry recovers, "Request coverage" says what happened, and with every read failed (?state=failed) each part says so with Retry and nothing shows an empty list or a zero.
//
// Usage: node tests/ux/market-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { checkClientReads, SHELL_READS } from './client-sweep.mjs';
import { chromium, open as openPage, smoke, VIEWPORTS, WIDTHS } from './harness.mjs';
import { listInvariants, rowReport } from './list-invariants.mjs';
import { measurePage } from './measure.mjs';

const run = smoke('market-smoke');
const { base, fail, check, must: ensure } = run;
const EVENT = { id: 'e1', event_date: '2026-11-29', date_precision: 'day', event_kind: 'compliance_deadline', obligation_text: 'Fixture obligation text that is long enough to need clamping at two lines inside the card.', item: { id: 'i1', title: 'Fixture regulation', legacy_id: null, jurisdiction_iso: ['EU'] } };
const NOTICE = { value_id: 'v2', entityId: 'e', entityLabel: 'Shanghai (CN) → Rotterdam (NL), ocean', methodId: 'market_series_delta', oldMethodVersion: '1.0.0', newMethodVersion: '1.0.0', oldValue: 1, newValue: 2, unit: 'USD', currency: null, supersededAt: '2026-10-12T00:00:00Z', newValueId: 'v2', oldValueId: 'v1', triggeringEvent: null };

/** The three routes the Market page's client parts call, answered in the browser; `state.notices` is 'down' to refuse the notices read. */
async function install(page, state) {
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    const m = route.request().method();
    state.calls.push(`${m} ${u.pathname}${u.search}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/obligations/upcoming') return u.searchParams.get('scope') === 'all' ? json({ events: [EVENT, { ...EVENT, id: 'e2' }], hasJurisdictionFilter: false }) : json({ events: [EVENT], hasJurisdictionFilter: true, scope: { label: 'Ocean, EU' }, hiddenByScope: 13 });
    if (u.pathname === '/api/notices') return state.notices === 'down' ? json({ error: 'The recalculation feed is unavailable.' }, 503) : json({ notices: [NOTICE], since: '2026-09-16T00:00:00Z' });
    if (u.pathname === '/api/workspace/tags') return json({ tags: [], itemTags: {} });
    if (u.pathname === '/api/dashboard/coverage/request') return json({ ok: true, already: false });
    return json({ error: `unmocked ${m} ${u.pathname}` }, 404);
  });
}

async function open(browser, path, viewport, mocks = {}) {
  const state = { calls: [], notices: mocks.notices ?? 'ok' };
  const opened = await openPage(browser, `${base}${path}`, viewport, { prepare: (page) => install(page, state) });
  return { ...opened, state };
}

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const path of ['/privacy/ui-fixtures/market', '/privacy/ui-fixtures/market?state=failed']) {
      const where = `${viewport.join('x')} ${path.includes('failed') ? 'failed' : 'ok'}`;
      await check(where, async () => {
        const s = await open(browser, path, viewport);
        try {
          for (const o of await measurePage(s.page, { rows: false })) fail(where, o);
          for (const o of await listInvariants(s.page)) fail(where, o);
          await rowReport(s.page, `market ${where}`, `market-${path.includes('failed') ? 'failed' : 'ok'}`);
          for (const e of s.errors) fail(where, `page error: ${e}`);
        } finally {
          await s.ctx.close();
        }
      });
    }
  }

  await check('headline rating', async () => {
    const s = await open(browser, '/privacy/ui-fixtures/market', [1280, 800]);
    const cards = await s.page.locator('[data-audit="headline-card"]').count();
    ensure(cards >= 5, `expected the headline cards, found ${cards}`);
    const tiers = await s.page.locator('[data-audit="headline-card"] [data-part="chip-tier"]').count();
    ensure(tiers === cards, `every headline figure shows its source rating: ${tiers} of ${cards}`);
    ensure((await s.page.locator('[data-audit="headline-track"]').getAttribute('data-guard-strip')) !== null, 'the headline strip is a declared strip');
    ensure((await s.page.locator('details[open]').count()) === 0, 'every disclosure is closed by default');
    await s.ctx.close();
  });

  // UI-1 U9: the headline cards and the freshness notice write their data labels and absences in sentence case; the eyebrow and the title above the grid are the only capitals.
  await check('headline labels are sentence case', async () => {
    const s = await open(browser, '/privacy/ui-fixtures/market', [1280, 800]);
    const shouted = await s.page.evaluate(() => {
      const out = [];
      for (const root of document.querySelectorAll('[data-audit="headline-card"], [data-audit="series-freshness-panel"], [data-audit="headline-series"] > div > span')) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent || '').trim();
          const shown = getComputedStyle(n.parentElement).textTransform === 'uppercase' ? t.toUpperCase() : t;
          if (shown.replace(/[^A-Za-z]/g, '').length >= 5 && shown === shown.toUpperCase()) out.push(shown);
        }
      }
      return out;
    });
    ensure(shouted.length === 0, `capitals in a headline data label: ${shouted.slice(0, 4).join(' | ')}`);
    const text = await s.page.locator('[data-audit="headline-series"]').innerText();
    ensure(/No data yet/.test(text) || /\d/.test(text), 'the headline cards drew');
    await s.ctx.close();
  });

  await check('policy timeline scope', async () => {
    const s = await open(browser, '/privacy/ui-fixtures/market', [1280, 800]);
    const widen = s.page.locator('[data-audit="policy-scope-widen"]');
    ensure((await widen.innerText()).startsWith('13 hidden by your scope'), 'the hidden count is stated');
    ensure(((await s.page.locator('[data-audit="policy-scope-label"]').innerText()) ?? '') === 'Ocean, EU', 'the scope is shown as text');
    await widen.click();
    await s.page.locator('[data-audit="policy-scope-narrow"]').waitFor();
    ensure(s.state.calls.some((c) => c.includes('scope=all')), 'widening asks for every scope');
    await s.page.locator('[data-audit="policy-scope-narrow"]').click();
    await s.page.locator('[data-audit="policy-scope-widen"]').waitFor();
    await s.ctx.close();
  });

  await check('notices read', async () => {
    const s = await open(browser, '/privacy/ui-fixtures/market', [1280, 800], { notices: 'down' });
    const rail = s.page.locator('[data-notices-rail]');
    const text = await rail.innerText();
    ensure(/did not load/.test(text) && /Retry/.test(text), `a failed notices read says so with Retry: ${text.slice(0, 80)}`);
    ensure(!/No recalculations/.test(text), 'a failure is never "no recalculations"');
    s.state.notices = 'ok';
    await rail.getByRole('button', { name: 'Retry' }).click();
    await rail.getByText('How this was recalculated').waitFor();
    const body = await rail.innerText();
    ensure(!/market_series|derived_values|value_id/.test(body), 'the notice names no table or key');
    await s.ctx.close();
  });

  await check('request coverage', async () => {
    const s = await open(browser, '/privacy/ui-fixtures/market', [1280, 800]);
    await s.page.getByRole('button', { name: 'Request coverage' }).first().click();
    await s.page.getByText(/Requested/).first().waitFor();
    ensure(s.state.calls.includes('POST /api/dashboard/coverage/request'), 'the request was sent');
    await s.ctx.close();
  });

  await check('every failed part says so', async () => {
    const s = await open(browser, '/privacy/ui-fixtures/market?state=failed', [375, 812]);
    const alerts = await s.page.locator('[role=alert]').allInnerTexts();
    for (const what of ['Market signals', 'The headline series', 'The lead-time position', 'OEM equipment roadmap', 'Rerouting multipliers', 'The theme strip']) ensure(alerts.some((a) => a.includes(`${what} did not load`) || a.includes(`${what} could not be loaded`)), `${what} says it did not load`);
    ensure(/did not load/.test(await s.page.locator('[data-guard-container=coverage-denominator]').innerText()), 'the coverage count says it did not load');
    ensure((await s.page.getByRole('button', { name: 'Retry' }).count()) >= 8, 'each failed part offers Retry');
    ensure((await s.page.evaluate(() => [...document.querySelectorAll('li')].filter((l) => !l.closest('[data-notices-rail]')).length)) === 0, 'no list renders under a failure');
    const body = await s.page.locator('[data-fx="market"]').innerText();
    ensure(!/\b0 active signals\b/.test(body), 'a failed list is never zero signals');
    await s.ctx.close();
  });

  // Every read the Market screen makes after hydration is refused in turn and must be stated (the notices, the obligations, the tags).
  await check('client reads', () => checkClientReads(run, browser, { name: 'market', url: `${base}/privacy/ui-fixtures/market`, viewport: [1280, 800], prepare: (page) => install(page, { calls: [], notices: 'ok' }), ignore: SHELL_READS }));
} finally {
  await browser.close();
}

run.finish(`clean at ${WIDTHS}; every client read is stated when refused`);
