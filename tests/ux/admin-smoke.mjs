// The admin UX smoke (P2-14): the console (every section, every sub-tab and every view inside a tab), the item corrections screen, the factors page (and its failure), the inferences page and the
// coverage page, mounted on /privacy/ui-fixtures/admin?screen=<name> against MOCKED backend responses, at 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on:
// horizontal overflow, a title narrower than its longest word, a squeezed list title, an interactive target below the law-2 floor, or a page error.
//
// Every console tab is measured in BOTH states (G2b): POPULATED (tests/ux/admin-mocks.mjs answers every read the tabs make with rows long enough to wrap) and FAILED (every unmocked /api call answers a stated 503,
// so the failure note with Retry is what renders). A populated mock the smoke never asked for fails the smoke: it would be a tab measured only as a failure. The real screens sit behind the admin guard and
// capture only on the deployed preview (P2-15); this smoke is their layout proof.
//
// Usage: node tests/ux/admin-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { answer, SERVED } from './admin-mocks.mjs';
import { chromium, open as openPage, smoke, VIEWPORTS, WIDTHS } from './harness.mjs';
import { measurePage } from './measure.mjs';

const SCREENS = ['console', 'item', 'factors', 'factors-failed', 'inferences', 'coverage'];
const SECTIONS = {
  Workspaces: ['Organizations'],
  Sources: ['Provisional review', 'Source registry', 'Bulk add', 'Tier disagreements', 'Spot-check'],
  Ingest: ['Flags & rejections', 'Staged updates', 'Dispatch', 'Statutory rows', 'Corrections'],
  Coverage: ['Jurisdiction review', 'Coverage matrix', 'Catalogue'],
  'Research pipeline': ['Pipeline'],
  Runtime: ['Errors', 'Assumptions', 'Inferences'],
};
// The views inside a tab: the three kinds of the flags queue, and the seven views of the source registry card.
const FLAG_KINDS = ['Integrity', 'Platform', 'Rejections'];
const REGISTRY_VIEWS = ['Source registry', 'Health', 'Provisional', 'Canonical source issues', 'Intersections', 'Themes', 'Upcoming obligations'];

const run = smoke('admin-smoke');
const { base, fail, check, must } = run;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');

/** `state.mode` is 'populated' (admin-mocks answers) or 'failed' (a stated 503 for every admin read); `state.served` collects the paths a populated answer was given for. */
async function install(page, state) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  await page.route('**/api/**', (route) => {
    const { pathname: p, search } = new URL(route.request().url());
    state.calls.push(`${route.request().method()} ${p}${search}`);
    if (p === '/api/auth/identity') return json(route, { user: { id: 'u1', email: 'olga@example.invalid' }, orgId: null, orgName: null, role: null, sectors: [], workspaceSectors: [], isPlatformAdmin: true });
    if (state.mode === 'populated') {
      const body = answer(p, search);
      if (body !== undefined) {
        state.served.add(p);
        return json(route, body);
      }
    }
    return json(route, { error: 'the mocked backend has no answer for this call' }, 503);
  });
  await page.route('**/rest/v1/**', (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' })));
}

async function open(browser, screen, viewport, mode = 'populated') {
  const state = { calls: [], mode, served: new Set() };
  const opened = await openPage(browser, `${base}/privacy/ui-fixtures/admin?screen=${screen}`, viewport, { prepare: (page) => install(page, state) });
  return { ...opened, state };
}

/** A tab is ready when its skeleton rows are gone and the network is quiet: the read has answered, populated or failed. */
async function tabReady(page) {
  await page.waitForFunction(() => !document.querySelector('[data-admin-console] .cl-skel-row'), null, { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}
const pickTab = async (page, tablist, name) => {
  await page.getByRole('tablist', { name: tablist, exact: true }).getByRole('tab', { name: new RegExp(`^${escape(name)}`) }).click();
  await tabReady(page);
};

/** Walks every section, tab and inner view of the console and measures each one. */
async function sweepConsole(page, where) {
  const measureHere = async (what) => {
    for (const o of await measurePage(page, { rows: false })) fail(`${where} ${what}`, o);
  };
  for (const [section, tabs] of Object.entries(SECTIONS)) {
    await page.locator('button[aria-pressed]', { hasText: section }).first().click();
    for (const tab of tabs) {
      await pickTab(page, `${section} views`, tab);
      await measureHere(`${section} > ${tab}`);
      if (tab === 'Flags & rejections') {
        for (const kind of FLAG_KINDS) {
          await pickTab(page, 'Flag kind', kind);
          await measureHere(`${section} > ${tab} > ${kind}`);
        }
      }
      if (tab === 'Source registry') {
        for (const view of REGISTRY_VIEWS) {
          await pickTab(page, 'Source registry views', view);
          await measureHere(`${section} > ${tab} > ${view}`);
        }
      }
    }
  }
}

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      for (const mode of screen === 'console' ? ['populated', 'failed'] : ['populated']) {
        const where = `${viewport.join('x')} ${screen}${screen === 'console' ? ` ${mode}` : ''}`;
        await check(where, async () => {
          const s = await open(browser, screen, viewport, mode);
          try {
            for (const o of await measurePage(s.page, { rows: false })) fail(where, o);
            if (screen === 'console') {
              await sweepConsole(s.page, where);
              if (mode === 'populated' && viewport[0] === 1280) for (const path of SERVED) if (!s.state.served.has(path)) fail(where, `the populated mock for ${path} was never asked for: that tab is measured only as a failure`);
            }
            for (const e of s.errors) fail(where, `page error: ${e}`);
          } finally {
            await s.ctx.close();
          }
        });
      }
    }
  }

  await check('a read that failed renders a failure note with Retry, and no zero or empty list stands in for it', async () => {
    const s = await open(browser, 'console', [1280, 800], 'failed');
    try {
      await s.page.locator('button[aria-pressed]', { hasText: 'Runtime' }).first().click();
      await s.page.getByRole('button', { name: /try again|retry/i }).first().waitFor({ timeout: 15000 });
      const text = await s.page.locator('[data-admin-console]').innerText();
      must(!/No errors|0 error/i.test(text), 'a failed read rendered as an empty state');
    } finally {
      await s.ctx.close();
    }
  });

  await check('a populated read renders its rows, and Retry is absent', async () => {
    const s = await open(browser, 'console', [1280, 800]);
    try {
      await s.page.locator('button[aria-pressed]', { hasText: 'Runtime' }).first().click();
      await tabReady(s.page);
      const text = await s.page.locator('[data-admin-console]').innerText();
      must(/TypeError: cannot read properties/.test(text), 'the populated runtime errors did not render');
      must(!(await s.page.getByRole('button', { name: /try again|retry/i }).count()), 'a populated tab offers Retry');
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

run.finish(`clean (${SCREENS.length} screens, ${Object.values(SECTIONS).flat().length} console tabs in both states, ${FLAG_KINDS.length + REGISTRY_VIEWS.length} inner views, ${WIDTHS})`);
