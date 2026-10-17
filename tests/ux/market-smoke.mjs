// The Market UX smoke (P2-11): the Market page mounted on /privacy/ui-fixtures/market from fixed data, with MOCKED responses for the three routes the page's client parts call, at 375x812, 768x1024, 1024x768 and 1280x800 with the real
// fonts. It fails on: horizontal overflow outside a declared strip, a title narrower than its longest word, an interactive target below the law-2 floor. Then the behaviour contracts: the headline strip carries each figure's source rating, the
// policy timeline widens and narrows its scope, a failed notices read says so and Retry recovers, "Request coverage" says what happened, and with every read failed (?state=failed) each part says so with Retry and nothing shows an empty list or a zero.
//
// Usage: node tests/ux/market-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { chromium } from 'playwright';

import { measure } from './measure.mjs';

const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
];
const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base.startsWith('--')) throw new Error('usage: market-smoke.mjs --base <origin>');

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const EVENT = { id: 'e1', event_date: '2026-11-29', date_precision: 'day', event_kind: 'compliance_deadline', obligation_text: 'Fixture obligation text that is long enough to need clamping at two lines inside the card.', item: { id: 'i1', title: 'Fixture regulation', legacy_id: null, jurisdiction_iso: ['EU'] } };
const NOTICE = { value_id: 'v2', entityId: 'e', entityLabel: 'Shanghai (CN) → Rotterdam (NL), ocean', methodId: 'market_series_delta', oldMethodVersion: '1.0.0', newMethodVersion: '1.0.0', oldValue: 1, newValue: 2, unit: 'USD', currency: null, supersededAt: '2026-10-12T00:00:00Z', newValueId: 'v2', oldValueId: 'v1', triggeringEvent: null };

async function open(browser, path, [w, h], mocks = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const state = { calls: [], notices: mocks.notices ?? 'ok' };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
  const res = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) throw new Error(`fixture page answered ${res?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  return { ctx, page, errors, state };
}

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const path of ['/privacy/ui-fixtures/market', '/privacy/ui-fixtures/market?state=failed']) {
      const where = `${viewport.join('x')} ${path.includes('failed') ? 'failed' : 'ok'}`;
      let s;
      try {
        s = await open(browser, path, viewport);
        for (const o of await s.page.evaluate(measure, { rows: false })) fail(where, o);
        for (const e of s.errors) fail(where, `page error: ${e}`);
      } catch (e) {
        fail(where, e.message);
      } finally {
        await s?.ctx.close();
      }
    }
  }

  const check = async (name, run) => {
    try {
      await run();
    } catch (e) {
      fail(name, e.message);
    }
  };
  const ensure = (cond, what) => {
    if (!cond) throw new Error(what);
  };

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
    for (const what of ['Market signals', 'The headline series', 'Carbon cost per FEU', 'The lead-time position', 'OEM equipment roadmap', 'Rerouting multipliers', 'The theme strip']) ensure(alerts.some((a) => a.includes(`${what} did not load`) || a.includes(`${what} could not be loaded`)), `${what} says it did not load`);
    ensure(/did not load/.test(await s.page.locator('[data-guard-container=coverage-denominator]').innerText()), 'the coverage count says it did not load');
    ensure((await s.page.getByRole('button', { name: 'Retry' }).count()) >= 8, 'each failed part offers Retry');
    ensure((await s.page.evaluate(() => [...document.querySelectorAll('li')].filter((l) => !l.closest('[data-notices-rail]')).length)) === 0, 'no list renders under a failure');
    const body = await s.page.locator('[data-fx="market"]').innerText();
    ensure(!/\b0 active signals\b/.test(body), 'a failed list is never zero signals');
    await s.ctx.close();
  });
} finally {
  await browser.close();
}

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(`market-smoke: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('market-smoke: clean at 375x812, 768x1024, 1024x768, 1280x800');
