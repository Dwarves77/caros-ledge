// The admin UX smoke (P2-14): the console (every section and every sub-tab), the item corrections screen, the factors page (and its failure), the inferences page and the
// coverage page, mounted on /privacy/ui-fixtures/admin?screen=<name> against MOCKED backend responses (every /api/admin call is fulfilled in the browser; an unmocked
// call answers a stated 503 so the failure state, not an empty one, is what renders), at 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on:
// horizontal overflow, a title narrower than its longest word, an interactive target below the law-2 floor, or a page error. The real screens sit behind the admin
// guard and capture only on the deployed preview (P2-15); this smoke is their layout proof.
//
// Usage: node tests/ux/admin-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { chromium } from 'playwright';

import { measure } from './measure.mjs';

const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
];
const SCREENS = ['console', 'item', 'factors', 'factors-failed', 'inferences', 'coverage'];
const SECTIONS = {
  Workspaces: ['Organizations'],
  Sources: ['Provisional review', 'Source registry', 'Bulk add', 'Tier disagreements', 'Spot-check'],
  Ingest: ['Flags & rejections', 'Staged updates', 'Dispatch', 'Statutory rows', 'Corrections'],
  Coverage: ['Jurisdiction review', 'Coverage matrix', 'Catalogue'],
  'Research pipeline': ['Pipeline'],
  Runtime: ['Errors', 'Assumptions', 'Inferences'],
};
const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base.startsWith('--')) throw new Error('usage: admin-smoke.mjs --base <origin>');

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');

async function install(page, state) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  await page.route('**/api/**', (route) => {
    const { pathname: p, search } = new URL(route.request().url());
    state.calls.push(`${route.request().method()} ${p}${search}`);
    if (p === '/api/auth/identity') return json(route, { user: { id: 'u1', email: 'olga@example.invalid' }, orgId: null, orgName: null, role: null, sectors: [], workspaceSectors: [], isPlatformAdmin: true });
    if (p === '/api/admin/runtime' && search.includes('inferences')) return json(route, { rows: [], itemTitles: {} });
    return json(route, { error: 'the mocked backend has no answer for this call' }, 503);
  });
  await page.route('**/rest/v1/**', (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' })));
}

async function open(browser, screen, [w, h], state = { calls: [] }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await install(page, state);
  const res = await page.goto(`${base}/privacy/ui-fixtures/admin?screen=${screen}`, { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) throw new Error(`fixture page answered ${res?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errors, state };
}

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const where = `${viewport.join('x')} ${screen}`;
      let s;
      try {
        s = await open(browser, screen, viewport);
        await s.page.waitForTimeout(300);
        for (const o of await s.page.evaluate(measure, { rows: false })) fail(where, o);
        if (screen === 'console') {
          // Every section and every sub-tab: the layout holds, and a tab whose read failed says so (a failed read is a note with Retry, never an empty list or a zero).
          for (const [section, tabs] of Object.entries(SECTIONS)) {
            await s.page.locator('button[aria-pressed]', { hasText: section }).first().click();
            for (const tab of tabs) {
              await s.page.getByRole('tablist', { name: `${section} views`, exact: true }).getByRole('tab', { name: new RegExp(`^${escape(tab)}`) }).click();
              await s.page.waitForTimeout(150);
              for (const o of await s.page.evaluate(measure, { rows: false })) fail(`${where} ${section} > ${tab}`, o);
            }
          }
        }
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

  await check('a read that failed renders a failure note with Retry, and no zero or empty list stands in for it', async () => {
    const s = await open(browser, 'console', [1280, 800]);
    try {
      await s.page.locator('button[aria-pressed]', { hasText: 'Runtime' }).first().click();
      await s.page.getByRole('button', { name: /try again|retry/i }).first().waitFor({ timeout: 15000 });
      const text = await s.page.locator('[data-admin-console]').innerText();
      must(!/No errors|0 error/i.test(text), 'a failed read rendered as an empty state');
    } finally {
      await s.ctx.close();
    }
  });

  await check('the masthead total and the issues rail agree (INV-281)', async () => {
    const s = await open(browser, 'console', [1280, 800]);
    try {
      const text = await s.page.locator('[data-admin-console]').innerText();
      must(/12 items need attention/.test(text), 'the masthead total is not the attention total');
      must(/Ingest rejections untriaged/.test(text), 'the rejections row is missing from the rail');
    } finally {
      await s.ctx.close();
    }
  });

  await check('the factors page states a failed read instead of an empty table', async () => {
    const s = await open(browser, 'factors-failed', [1280, 800]);
    try {
      must(/did not load/.test(await s.page.locator('[data-fx="admin"]').innerText()), 'the failure was not stated');
    } finally {
      await s.ctx.close();
    }
  });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`admin-smoke: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`admin-smoke: clean (${SCREENS.length} screens, ${Object.values(SECTIONS).flat().length} console tabs, ${VIEWPORTS.length} widths)`);
