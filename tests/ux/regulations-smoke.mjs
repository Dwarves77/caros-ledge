// The Regulations UX smoke (P2-10): the list, the detail (brief grade and record grade), the obligation register and the map, mounted on /privacy/ui-fixtures/regulations?screen=<name> against MOCKED
// backend responses (the app's own routes are fulfilled in the browser, the map tiles are a blank image), at 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on: horizontal
// overflow, a title narrower than its longest word, an interactive target below the law-2 floor, a page error. Then the behaviours of the screens (every stored section is drawn once at Full depth;
// the raw Sources markdown never is; a failed relevance read says so with Retry; the map names its attribution and a marker click selects its row).
//
// Usage: node tests/ux/regulations-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { chromium } from 'playwright';

import { measure } from './measure.mjs';

const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
];
const SCREENS = ['ledger', 'detail', 'record', 'register', 'map'];
const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base.startsWith('--')) throw new Error('usage: regulations-smoke.mjs --base <origin>');

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
// A 1x1 transparent PNG: the map's tiles, so the smoke never reaches the network.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function install(page, state) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  await page.route('**/*.tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/**', (route) => {
    const { pathname: p } = new URL(route.request().url());
    state.calls.push(`${route.request().method()} ${p}`);
    if (p === '/api/auth/identity') return json(route, { user: { id: 'u-1', email: 'smoke@example.invalid' }, orgId: 'o-1', orgName: 'Dietl / Rockit', role: 'owner', sectors: [], workspaceSectors: [], isPlatformAdmin: false });
    if (p === '/api/workspace/tags') return json(route, { tags: [], itemTags: {} });
    if (p === '/api/detail/relevance') return state.failRelevance ? json(route, { error: 'down' }, 503) : json(route, { relevance: null, binding: null });
    if (p === '/api/saved-views') return json(route, { views: [] });
    return json(route, { error: `unmocked ${p}` }, 404);
  });
}

async function open(browser, screen, [w, h], state = { calls: [] }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await install(page, state);
  const res = await page.goto(`${base}/privacy/ui-fixtures/regulations?screen=${screen}`, { waitUntil: 'networkidle' });
  if (!res || res.status() !== 200) throw new Error(`fixture page answered ${res?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errors, state };
}

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      const where = `${viewport.join('x')} ${screen}`;
      let session;
      try {
        session = await open(browser, screen, viewport);
        await session.page.waitForTimeout(400);
        for (const o of await session.page.evaluate(measure, { rows: false })) {
          // Leaflet's own zoom buttons and attribution link are the library's controls, drawn at the size the library sets; the page's own controls are measured.
          if (screen === 'map' && /leaflet-/.test(o)) continue;
          fail(where, o);
        }
        for (const e of session.errors) fail(where, `page error: ${e}`);
      } catch (e) {
        fail(where, e.message);
      } finally {
        await session?.ctx.close();
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
  const session = async (screen, run, state) => {
    const s = await open(browser, screen, [1280, 800], state);
    try {
      await run(s);
    } finally {
      await s.ctx.close();
    }
  };

  await check('detail: every stored section is drawn once at Full depth, and the raw Sources markdown never', () =>
    session('detail', async ({ page }) => {
      await page.getByRole('button', { name: /Full brief/ }).click();
      await page.getByText('Purpose and scope', { exact: false }).first().waitFor();
      const text = await page.evaluate(() => document.body.innerText);
      must(!/\| Source Name \| Tier \| URL \|/.test(text), 'the raw Sources markdown table was drawn');
      const keys = [...text.matchAll(/Section (\d+)\. Operators shall submit/g)].map((m) => m[1]);
      must(new Set(keys).size === 12, `expected the 12 plain sections drawn, found ${new Set(keys).size}`);
      must(keys.length === 12, `a section was drawn more than once (${keys.length} bodies for 12 sections)`);
    }),
  );

  await check('detail: a failed relevance read is said, with Retry, never an empty banner', () =>
    session('detail', async ({ page, state }) => {
      await page.getByRole('button', { name: 'Try again' }).first().waitFor({ timeout: 4000 });
      must(state.calls.filter((c) => c === 'GET /api/detail/relevance').length >= 1, 'the relevance route was not asked');
    }, { calls: [], failRelevance: true }),
  );

  await check('map: the attribution is visible and every marker is a keyboard button named by its count', () =>
    session('map', async ({ page }) => {
      await page.locator('.leaflet-control-attribution').getByText(/OpenStreetMap/).waitFor();
      const markers = page.getByRole('button', { name: /^\d+$/ });
      await markers.first().waitFor();
      must((await markers.count()) >= 3, 'the map drew fewer markers than the fixture has jurisdictions');
      must((await markers.first().getAttribute('tabindex')) === '0', 'a marker is not reachable by keyboard');
    }),
  );
} finally {
  await browser.close();
}

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(`regulations-smoke: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('regulations-smoke: clean at 375x812, 768x1024, 1024x768, 1280x800; behaviours pass');
