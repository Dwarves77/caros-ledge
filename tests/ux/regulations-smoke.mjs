// The Regulations UX smoke (P2-10): the list, the detail (brief grade and record grade), the obligation register and the map, mounted on /privacy/ui-fixtures/regulations?screen=<name> against MOCKED
// backend responses (the app's own routes are fulfilled in the browser, the map tiles are a blank image), at 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on: horizontal
// overflow, a title narrower than its longest word, an interactive target below the law-2 floor, a page error. Then the behaviours of the screens (every stored section is drawn once at Full depth;
// the raw Sources markdown never is; a failed relevance read says so with Retry; the map names its attribution and a marker click selects its row).
//
// Usage: node tests/ux/regulations-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { chromium } from 'playwright';

import { hitArea, measure } from './measure.mjs';

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

  // P2-15e: the connections strip in the masthead card. A record title can run to hundreds of words, so the strip clamps every title to two lines (the old page did); the strip is padded like the card's other blocks, never
  // full-bleed; and no empty band separates it from the block above. Measured at 375 and 1280, on a fixture whose first title is 600 characters.
  for (const viewport of [[375, 812], [1280, 800]]) {
    await check(`detail at ${viewport[0]}: the connections strip clamps titles to two lines, is padded, and sits close under the block above`, async () => {
      const s = await open(browser, 'detail', viewport);
      try {
        const m = await s.page.evaluate(() => {
          const strip = document.querySelector('[data-part="item-connections"]');
          if (!strip) return null;
          const card = strip.closest('header') ?? strip.parentElement;
          const cardLeft = card.getBoundingClientRect().left;
          const titles = [...strip.querySelectorAll('.cl-detail-link-title')].filter((el) => el.getClientRects().length);
          const lines = titles.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
          const link = strip.querySelector('.cl-detail-link');
          const label = strip.querySelector('.cl-detail-label').getBoundingClientRect();
          const above = strip.parentElement.previousElementSibling;
          return { count: titles.length, lines, inset: link.getBoundingClientRect().left - cardLeft, band: above ? label.top - above.getBoundingClientRect().bottom : 0, full: titles[0].textContent.length };
        });
        must(m, 'the connections strip was not drawn');
        must(m.count >= 4, `expected four connection titles drawn, found ${m.count}`);
        must(m.full >= 600, `the 600-character title was not drawn whole in the DOM (${m.full})`);
        must(m.lines.every((n) => n <= 2), `a connection title runs to more than two lines: ${JSON.stringify(m.lines)}`);
        must(m.inset >= 16, `the connections strip is full-bleed: first link ${Math.round(m.inset)} px from the card edge`);
        must(m.band <= 48, `an empty band of ${Math.round(m.band)} px separates the connections strip from the block above`);
      } finally {
        await s.ctx.close();
      }
    });
  }

  // Design ruling 2026-10-18 item 21: the list surface's sort link ("Show as one list") keeps its 24 px look and line, with a 44 px hit area, at the phone and the desk.
  for (const viewport of [VIEWPORTS[0], VIEWPORTS[3]]) {
    await check(`ledger at ${viewport[0]}: the sort link has a 44 px hit area and does not grow its row`, async () => {
      const s = await open(browser, 'ledger', viewport);
      try {
        const found = await s.page.evaluate(hitArea, '.cl-sort-link');
        if (!found.length) throw new Error('no sort link on the ledger fixture');
        for (const f of found) {
          if (f.hitH < 43.5) throw new Error(`sort link "${f.label}" hit area ${f.hitW}x${f.hitH}, expected at least 44 high`);
          if (f.layoutH > 28) throw new Error(`sort link "${f.label}" box grew to ${f.layoutH} px`);
        }
      } finally {
        await s.ctx.close();
      }
    });
  }

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
