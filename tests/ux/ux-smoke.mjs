// The UX smoke (PROP-025, PROP-124, PROP-073): every row and card part, mounted with fixtures (/privacy/ui-fixtures, a 404 unless UI_FIXTURES=1), at
// 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on: horizontal overflow; a title narrower than its longest word; an interactive
// target below the law-2 floor (44 px on the shorter axis, or 24 px with 8 px clear of every other target); a 100-row list that carries its CSS more than once
// or any inline <style>. Then the behaviour contracts: the Dialog (Esc closes, focus returns to the opener), the back-to-top button bound to <main>,
// the failed-remainder note with Retry, and an anonymous /privacy that issues no notifications, bootstrap or admin request.
//
// Usage: node tests/ux/ux-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BYPASS_HEADER, installBypass, wholePageScreenshot } from '../parity/capture.mjs';
import { ROW_SELECTOR } from '../parity/contract.mjs';

import { sweepClientReads } from './client-sweep.mjs';
import { chromium, exactlyOne, open, settled, smoke, summarise, VIEWPORTS, WIDTHS } from './harness.mjs';
import { listInvariants } from './list-invariants.mjs';
import { measurePage } from './measure.mjs';

const run = smoke('ux-smoke');
const { base, fail, check, must } = run;

// The matrix contracts (operator 2026-09-09): the card height is constant across arrival, a selected cell, compare mode and Esc; arrows move the selection and Home moves only; Esc closes; the dimension column stays
// pinned while the regions scroll; six regions scroll inside the card where five fit; the arrival state declares itself and the declaration goes when the reader acts.
async function matrixContracts(page, w, where) {
  const card = page.locator('[data-fx="matrix-six"] [data-audit="ops-matrix-card"]');
  const heights = [];
  const height = async () => Math.round((await card.boundingBox()).height);
  heights.push(['arrival', await height()]);
  if (!(await card.locator('[data-open-on-mount]').count())) fail(where, 'the arrival state is not declared');
  // Design ruling 2026-10-18 item 35 (22 merged): every matrix cell and dimension row is a 44 px target (artboard 08 draws 40). Market draws no matrix of its own; the one matrix is this one.
  const cellHeights = await card.locator('td[role="gridcell"], th[role="rowheader"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10));
  if (!cellHeights.length || Math.min(...cellHeights) < 43.5) fail(where, `a matrix cell is under 44 px: smallest ${Math.min(...cellHeights)} of ${cellHeights.length}`);
  const first = card.locator('td[aria-selected="true"]');
  if ((await first.count()) !== 1) fail(where, 'the first sourced cell is not selected on arrival');
  const before = await first.getAttribute('aria-label');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  const after = await card.locator('[aria-selected="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  if (after.length !== 1 || after[0] === before) fail(where, `ArrowRight did not move the selection: ${before} -> ${after.join('|')}`);
  if (await card.locator('[data-open-on-mount]').count()) fail(where, 'the arrival declaration stayed after the reader acted');
  heights.push(['arrow', await height()]);
  await page.keyboard.press('Home');
  const afterHome = await page.evaluate(() => document.activeElement?.getAttribute('role'));
  if (afterHome !== 'rowheader') fail(where, `Home did not move focus to the row header: ${afterHome}`);
  if ((await card.locator('[aria-selected="true"]').count()) !== 1 || (await card.locator('th[aria-selected="true"]').count()) !== 0) fail(where, 'Home changed the selection (it only moves)');
  await page.keyboard.press('Enter');
  if (!(await card.locator('[data-audit="ops-compare-label"]').count())) fail(where, 'a row header did not open compare mode');
  heights.push(['compare', await height()]);
  await page.keyboard.press('Escape');
  if (!(await card.locator('[data-audit="ops-panel-empty"]').count())) fail(where, 'Esc did not close the panel');
  heights.push(['closed', await height()]);
  await card.locator('td[aria-label*="European Union, D3 Labor markets"]').click();
  if (!(await card.locator('[data-audit="labour-chain"]').count())) fail(where, 'the labour cell did not open the labour chain');
  heights.push(['labour', await height()]);
  if (new Set(heights.map(([, v]) => v)).size !== 1) fail(where, `the matrix card height moves with the selection: ${heights.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const six = page.locator('[data-fx="matrix-six"] .cl-scroll-shadow');
  const five = page.locator('[data-fx="matrix-five"] .cl-scroll-shadow');
  const scrolls = (l) => l.evaluate((e) => e.scrollWidth > e.clientWidth + 1);
  if (!(await scrolls(six))) fail(where, 'six regions do not scroll inside the card');
  if (w >= 1024 && (await scrolls(five))) fail(where, 'five regions scroll where they fit');
  const pinned = await six.evaluate(async (el) => {
    el.scrollLeft = 260;
    await new Promise((r) => setTimeout(r, 50));
    const head = el.querySelector('th[role="rowheader"]').getBoundingClientRect();
    return { moved: el.scrollLeft, delta: Math.abs(head.left - el.getBoundingClientRect().left) };
  });
  if (pinned.moved < 1 || pinned.delta > 2) fail(where, `the dimension column is not pinned while the regions scroll: scrolled ${pinned.moved}, off by ${pinned.delta}`);
}

// The Research list contracts: a theme pill is a URL state (a view can be linked), a chosen theme offers Clear, the awareness note points at the legend, a row's overflow menu opens.
async function researchContracts(page, where) {
  const pill = page.getByRole('button', { name: /^Fuels & SAF/ });
  // The old surface always carried the Workspace tags facet group (one "All" chip when the workspace has no tags): three groups, tags last, before the Filters button.
  const groups = await page.locator('.cl-facets-mobile > *').count();
  if (groups !== 3) fail(where, `the mobile facet strip holds ${groups} groups, expected Mode, Region and Workspace tags`);
  if (!(await pill.count())) return fail(where, 'the Fuels & SAF theme pill is missing');
  await pill.first().click();
  await page.waitForURL(/theme=fuels_saf/);
  if ((await page.getByRole('button', { name: /Clear theme/ }).count()) === 0) fail(where, 'a chosen theme offers no Clear theme');
  await page.goto(`${new URL(page.url()).origin}/privacy/ui-fixtures/surfaces?screen=research`, { waitUntil: 'load' });
  await settled(page);
  await page.getByRole('button', { name: 'Research item actions' }).first().click();
  if (!(await page.getByRole('menuitem', { name: 'Copy link' }).count())) fail(where, 'the row menu offers no Copy link');
  await page.keyboard.press('Escape');
  if (!(await page.getByRole('link', { name: 'How impact is read →' }).count())) fail(where, 'the awareness note does not point at the legend');
}

const browser = await chromium.launch();
try {
  for (const [w, h] of VIEWPORTS) {
    const where = `${w}x${h}`;
    await check(where, async () => {
      const { ctx, page } = await open(browser, `${base}/privacy/ui-fixtures`, [w, h]);
      try {
        for (const o of await measurePage(page, { rows: true })) fail(where, o);
        for (const o of await listInvariants(page)) fail(where, o);
        if (w === 375) {
          // The four band tiles sit in a 2x2 grid at 375.
          const tiles = await page.$$eval('[data-fx="tiles"] .cl-band-tile', (els) => els.map((e) => e.getBoundingClientRect().top));
          if (new Set(tiles.map((t) => Math.round(t))).size !== 2) fail(where, `band tiles are not 2x2: ${tiles.join(',')}`);
        }
        // The failed remainder says so, offers Retry, and the first page is not presented as the whole list.
        const note = await page.locator('[data-fx="surface"] [role=alert]').first().innerText();
        if (!/did not load/i.test(note) || !/Retry/.test(note)) fail(where, `the failed-remainder note is wrong: ${note}`);
        // Dialog focus contract. The opener is one element: a second one is the duplicate id of IMP-128, and the page HTML is printed to show where it came from.
        const opener = await exactlyOne(page, '#fx-open-dialog', 'the dialog opener');
        await opener.focus();
        await opener.click();
        const inside = await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
        if (!inside) fail(where, 'opening the dialog did not move focus inside it');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        if (!(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')))) fail(where, 'Tab escaped the dialog');
        await page.keyboard.press('Escape');
        if (await page.locator('[role=dialog]').count()) fail(where, 'Esc did not close the dialog');
        if (!(await page.evaluate(() => document.activeElement?.id === 'fx-open-dialog'))) fail(where, 'focus did not return to the opener');
      } finally {
        await ctx.close();
      }
    });
  }

  // P2-12: the Research and Operations screens (the real parts and lists over fixtures) at the same four widths: law 2, overflow, titles, then the contracts of the matrix and the lists.
  for (const [w, h] of VIEWPORTS) {
    for (const screen of ['parts', 'research', 'operations']) {
      const where = `${w}x${h} ${screen}`;
      await check(where, async () => {
        const { ctx, page, errors } = await open(browser, `${base}/privacy/ui-fixtures/surfaces?screen=${screen}`, [w, h]);
        try {
          for (const o of await measurePage(page, { rows: false })) fail(where, o);
          // The absence rule: "pending", "unscored" and "not scored" never render on a customer surface.
          const text = await page.locator('[data-fx]').first().innerText();
          const banned = text.match(/\b(pending|unscored|not scored)\b/i);
          if (banned) fail(where, `the word "${banned[0]}" renders`);
          if (screen === 'parts') await matrixContracts(page, w, where);
          if (screen === 'research') await researchContracts(page, where);
          if (screen === 'operations') {
            for (const name of ['Regions side by side', 'Statements']) if (!(await page.getByRole('heading', { name }).count())) fail(where, `heading "${name}" is missing`);
            if (!(await page.locator('[data-audit="ops-matrix-panel"][data-open-on-mount]').count())) fail(where, 'the matrix does not arrive with its default cell open and declared');
            if (!(await page.getByText('Recalculated figures').count())) fail(where, 'the recalculated-figures rail card is missing');
          }
          for (const e of errors) fail(where, `page error: ${e}`);
        } finally {
          await ctx.close();
        }
      });
    }
  }

  // The signed-out routes are real pages, not fixtures: /login and /signup (the tabs and "Forgot password?" were 42 and 15 px high) meet the law-2 floor and do not overflow at every width.
  for (const [w, h] of VIEWPORTS) {
    for (const path of ['/login', '/signup']) {
      const where = `${w}x${h} ${path}`;
      await check(where, async () => {
        const { ctx, page } = await open(browser, `${base}${path}`, [w, h]);
        try {
          for (const o of await measurePage(page, { scope: 'body *' })) fail(where, o);
        } finally {
          await ctx.close();
        }
      });
    }
  }

  // Anonymous /privacy: the shell renders as the baseline does, but the page issues no notifications, bootstrap or admin request, and has a single main landmark.
  await check('privacy', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await ctx.newPage();
      const seen = [];
      page.on('request', (r) => seen.push(new URL(r.url()).pathname));
      await page.goto(`${base}/privacy`, { waitUntil: 'load' });
      await settled(page);
      const bad = seen.filter((p) => /notifications|workspace\/bootstrap|\/api\/admin/.test(p));
      if (bad.length) fail('privacy', `an anonymous page issued ${bad.join(', ')}`);
      if ((await page.locator('main').count()) !== 1) fail('privacy', 'the page does not have exactly one main landmark');
      if (!(await page.locator('[data-part=nav-card]').count())) fail('privacy', 'the shell nav card is missing on /privacy');
    } finally {
      await ctx.close();
    }
  });
  // P2-15e: the screens job photographs the shell, which scrolls inside <main>; the whole-page helper must grow the viewport to the scroll box so the PNG is the whole page, not one viewport.
  await check('whole-page screenshot', async () => {
    const viewport = { width: 375, height: 812 };
    const shot = await browser.newContext({ viewport });
    const dir = mkdtempSync(join(tmpdir(), 'whole-'));
    try {
      const tall = await shot.newPage();
      await tall.goto(`${base}/privacy`, { waitUntil: 'load' });
      await settled(tall);
      const content = await tall.evaluate(() => document.querySelector('main').scrollHeight);
      const { truncated } = await wholePageScreenshot(tall, viewport, join(dir, 'p.png'));
      const png = readFileSync(join(dir, 'p.png'));
      const height = png.readUInt32BE(20);
      if (content > viewport.height && height < content) fail('whole-page screenshot', `the PNG is ${height} px tall for ${content} px of page`);
      if (content <= viewport.height) fail('whole-page screenshot', `/privacy at 375 does not scroll inside main (${content} px): the check proves nothing`);
      if (truncated) fail('whole-page screenshot', `/privacy is reported truncated at ${content} px`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await shot.close();
    }
  });

  // G2: the parity capture's record of a page. It holds EVERY list row (no window of 20), counts them per container, takes the page height from <main> (the shell scrolls inside it), and says when the page was taller than
  // the screenshot ceiling instead of cutting it silently. The 100-row fixture is the list; /privacy is a page that scrolls inside <main>.
  await check('capture record: every list row, counted per container', async () => {
    const { ctx, page } = await open(browser, `${base}/privacy/ui-fixtures`, [1280, 800]);
    try {
      const dom = await summarise(page);
      const drawn = await page.locator(ROW_SELECTOR).count();
      must(drawn >= 100, `the fixture draws ${drawn} row parts, expected the 100-row list`);
      must(dom.rows.items.length === drawn, `the capture holds ${dom.rows.items.length} of ${drawn} list rows: a window of the list is not the list`);
      must(dom.rows.containers.reduce((n, c) => n + c.count, 0) === dom.rows.items.length && dom.rows.containers.length >= 1, `the container counts (${JSON.stringify(dom.rows.containers)}) do not add up to the rows`);
    } finally {
      await ctx.close();
    }
  });
  await check('capture record: the page height is that of the shell main, and a page taller than the screenshot ceiling is photographed in tiles', async () => {
    const viewport = { width: 375, height: 812 };
    const { ctx, page } = await open(browser, `${base}/privacy`, [viewport.width, viewport.height]);
    const dir = mkdtempSync(join(tmpdir(), 'tall-'));
    try {
      const dom = await summarise(page);
      const inMain = await page.evaluate(() => document.querySelector('main').scrollHeight);
      must(dom.document_height === inMain && inMain > viewport.height, `document_height is ${dom.document_height}, <main> scrolls ${inMain} (the viewport is ${viewport.height}): the page height of the shell is that of main`);
      await page.evaluate(() => {
        const tall = document.createElement('div');
        tall.style.height = '20000px';
        document.querySelector('main').append(tall);
      });
      const shot = await wholePageScreenshot(page, viewport, join(dir, 'tall.png'));
      must(shot.truncated === false && shot.tiles >= 2, `a page of 20000 px is ${shot.tiles} tile(s), truncated ${shot.truncated}: a page over the 16000 px ceiling is photographed in tiles, never cut`);
      must(existsSync(join(dir, 'tall.2.png')), 'the second tile was not written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await ctx.close();
    }
  });

  // The capture's protection bypass: the header reaches the server on every request to the captured origin when the secret is set, and is absent when it is not (a third party never gets it: bypassHeaders is tested).
  for (const [secret, present] of [['planted-secret-value', true], ['', false]]) {
    await check(`capture bypass header ${present ? 'present' : 'absent'}`, async () => {
      const ctx = await browser.newContext();
      try {
        await installBypass(ctx, new URL(base).origin, { VERCEL_AUTOMATION_BYPASS_SECRET: secret });
        const page = await ctx.newPage();
        const seen = [];
        page.on('request', (r) => void (new URL(r.url()).origin === new URL(base).origin && seen.push(r)));
        await page.goto(`${base}/login`, { waitUntil: 'load' });
        const headers = await Promise.all(seen.map((r) => r.allHeaders()));
        must(headers.length > 1, 'the page made no requests to its origin');
        must(headers.every((h) => (BYPASS_HEADER in h) === present && (!present || h[BYPASS_HEADER] === secret)), `the header is ${present ? 'missing from' : 'present on'} a request to the captured origin`);
      } finally {
        await ctx.close();
      }
    });
  }

  // G2b: the measure itself can fail. Each fault below is planted into a healthy fixture page and the measure must report it; a measure that cannot go red proves nothing about the real routes (the 119 px
  // title column of V-9 at 1280 is the planted fault in the third, and the real route's own is held by the parity capture's offences).
  const PLANTED = [
    ['a 20 px target', 'target under 24 px', (page) => page.evaluate(() => { const b = document.createElement('button'); b.textContent = 'go'; b.style.cssText = 'height:20px;width:90px'; document.querySelector('[data-fx]').append(b); })],
    ['a box that passes the right edge', 'overflow:', (page) => page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:0;width:3000px;height:10px'; document.querySelector('[data-fx]').append(d); })],
    ['a 119 px title column at 1280', 'list title column squeezed', (page) => page.addStyleTag({ content: '.cl-list-row { grid-template-columns: 3px 56px 119px 88px 84px 76px 40px 1fr !important; }' })],
    ['a focusable control collapsed to 1 px', 'focusable control collapsed', (page) => page.evaluate(() => { const b = document.createElement('button'); b.style.cssText = 'width:1px;height:1px;padding:0;border:0'; document.querySelector('[data-fx]').append(b); })],
  ];
  for (const [what, expected, plant] of PLANTED) {
    await check(`measure can fail: ${what}`, async () => {
      const { ctx, page } = await open(browser, `${base}/privacy/ui-fixtures`, [1280, 800]);
      try {
        must((await measurePage(page, { rows: true })).length === 0, 'the healthy fixture page is not clean, so the plant proves nothing');
        await plant(page);
        const offences = (await measurePage(page, { rows: false })).filter((o) => o.includes(expected));
        must(offences.length > 0, `${what} was planted and the measure reported no "${expected}"`);
      } finally {
        await ctx.close();
      }
    });
  }

  // V-9 (ruling 2026-10-20): below 1440 px the rail is folded, under the content and not beside it, so a list keeps its artboard width: 948 px at 1280 (the viewport less the nav card's 252 and the page's 2 x 40), and every row title is at least
  // its longest word wide, at the measure's 160 px floor, with no horizontal overflow. From 1440 px the rail sits beside the content again. The research fixture has the rail but no nav card, so it is narrowed by the nav card's width.
  for (const width of [1280, 1360, 1439, 1440]) {
    const folded = width < 1440;
    await check(`the rail is ${folded ? 'folded under' : 'beside'} the list at ${width}, titles keep their width`, async () => {
      const { ctx, page } = await open(browser, `${base}/privacy/ui-fixtures/surfaces?screen=research`, [width, 900]);
      try {
        await page.evaluate((w) => { document.querySelector('[data-fx]').style.width = `${w - 252}px`; }, width);
        const at = await page.evaluate(() => {
          const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
          return { col: box('.cl-list-surface-col'), rail: box('.cl-list-surface-rail'), titles: [...document.querySelectorAll('[data-part="list-row"] [data-guard-title]')].map((e) => Math.round(e.getBoundingClientRect().width)), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        must(at.titles.length >= 5, `the fixture draws ${at.titles.length} row titles`);
        if (folded) {
          must(at.rail.top >= at.col.bottom - 1, `the rail starts at y ${at.rail.top}, above the end of the list column at y ${at.col.bottom}: it is beside the list, not folded`);
          must(at.rail.left === at.col.left, `the folded rail is at x ${at.rail.left}, not under the list column at x ${at.col.left}`);
          must(at.col.width === width - 252 - 80, `the list column is ${at.col.width} px wide at ${width}: the folded rail leaves ${width - 252 - 80}`);
        } else {
          must(at.rail.left >= at.col.right && at.rail.top <= at.col.top + 1, `at ${width} the rail is not beside the list: rail x ${at.rail.left} y ${at.rail.top}, column to x ${at.col.right} from y ${at.col.top}`);
        }
        must(Math.min(...at.titles) >= 160, `a row title is ${Math.min(...at.titles)} px wide at ${width}: the floor is 160`);
        must(at.overflow <= 0, `the page overflows sideways by ${at.overflow} px at ${width}`);
        const offences = (await measurePage(page, { rows: false })).filter((o) => o.includes('title') || o.includes('overflow'));
        must(offences.length === 0, `the measure reports ${offences[0]}`);
      } finally {
        await ctx.close();
      }
    });
  }

  // A control that a sideways strip hides entirely is neither a target nor a neighbour; the same two controls, 2 px apart, are an offence when the strip shows them, and a control below the fold of a vertical scroller is still a control.
  const PLANTED_PAIRS = {
    'hidden by its sideways strip': { offence: false, html: '<div style="width:100px;height:30px;overflow-x:auto;white-space:nowrap;position:absolute;left:0;top:0"><span style="display:inline-block;width:300px"></span><button style="height:30px;width:100px;padding:0">B</button></div><button style="position:absolute;left:300px;top:32px;height:30px;width:100px;padding:0">A</button>' },
    'shown by its sideways strip': { offence: true, html: '<div style="width:100px;height:30px;overflow-x:auto;white-space:nowrap;position:absolute;left:0;top:0"><button style="height:30px;width:100px;padding:0">B</button></div><button style="position:absolute;left:100px;top:32px;height:30px;width:100px;padding:0">A</button>' },
    'below the fold of a vertical scroller': { offence: true, html: '<div style="width:300px;height:40px;overflow-y:auto;position:absolute;left:0;top:0"><div style="height:200px;position:relative"><button style="position:absolute;left:0;top:100px;height:30px;width:100px;padding:0">B</button><button style="position:absolute;left:0;top:132px;height:30px;width:100px;padding:0">A</button></div></div>' },
  };
  for (const [what, planted] of Object.entries(PLANTED_PAIRS)) {
    await check(`measure: a control ${what}${planted.offence ? ' is measured' : ' is not a neighbour'}`, async () => {
      const { ctx, page } = await open(browser, `${base}/privacy/ui-fixtures`, [1280, 800]);
      try {
        await page.evaluate((html) => {
          const box = document.createElement('div');
          box.style.cssText = `position:absolute;left:20px;top:${document.documentElement.scrollHeight + 200}px;width:500px;height:70px`;
          box.innerHTML = html;
          document.body.append(box);
        }, planted.html);
        const clear = (await measurePage(page, { rows: false })).filter((o) => o.includes('px clear of'));
        must(planted.offence ? clear.length > 0 : clear.length === 0, planted.offence ? `two controls 2 px apart (${what}) were not reported` : `a control ${what} was counted as a neighbour: ${clear[0]}`);
      } finally {
        await ctx.close();
      }
    });
  }

  // Two fact-card parts the real routes drew below the law-2 floor and wider than 375: an in-brief link is a 24 px box (market detail drew it 16 px), and a matrix headline with no figure wraps inside its card (operations drew it 421 px wide).
  const FACT_PARTS = {
    'an in-brief fact-card link': '<div class="cl-fc cl-fc--ink"><p class="cl-fc-claim">Industry coverage from <a class="cl-fc-inline-link" href="#x">packworld.com</a> in the brief.</p></div>',
    'a matrix headline of six long words': '<div class="cl-fc-matrix"><div class="cl-fc-matrix-lead"><span class="cl-fc-matrix-headline">Asia-Pacific — corrugated containerboard prices rising steadily</span></div></div>',
  };
  for (const [what, html] of Object.entries(FACT_PARTS)) {
    await check(`measure: ${what} meets the floor at 375`, async () => {
      const { ctx, page } = await open(browser, `${base}/privacy/ui-fixtures`, [375, 812]);
      try {
        await page.evaluate((markup) => document.querySelector('[data-fx]').insertAdjacentHTML('beforeend', markup), html);
        const offences = (await measurePage(page, { rows: false })).filter((o) => o.includes('cl-fc-inline-link') || o.includes('cl-fc-matrix-headline'));
        must(offences.length === 0, `${what} is reported: ${offences[0]}`);
      } finally {
        await ctx.close();
      }
    });
  }

  // G5: the client-read sweep itself can fail. Four planted screens (served from a fake origin): a read whose failure is drawn as a zero, one that states it, a healthy screen that already carries "Retry", and one that reads nothing.
  const planted = (script, copy = '') => `<!doctype html><html><body><main><p id="o">loading</p>${copy}</main><script>${script};document.documentElement.dataset.hydrated='true'</script></body></html>`;
  const FETCH = "fetch('/api/x').then((r)=>r.ok?r.json():Promise.reject()).then((d)=>{o.textContent='count '+d.n},";
  const SCREENS = {
    silent: planted(`const o=document.getElementById('o');${FETCH}()=>{o.textContent='count 0'})`),
    stating: planted(`const o=document.getElementById('o');${FETCH}()=>{o.textContent='The count could not be loaded. Retry'})`),
    staticRetry: planted(`const o=document.getElementById('o');${FETCH}()=>{o.textContent='count 0'})`, '<p>Anything wrong? Retry from the menu.</p>'),
    nothing: planted("document.getElementById('o').textContent='static'"),
  };
  const sweepPlanted = (name) => sweepClientReads(browser, {
    name,
    url: 'http://planted.test/',
    viewport: [1024, 768],
    prepare: async (page) => {
      await page.route('http://planted.test/**', (route) => (new URL(route.request().url()).pathname === '/api/x' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"n":3}' }) : route.fulfill({ status: 200, contentType: 'text/html', body: SCREENS[name] })));
    },
  });
  await check('client sweep can fail', async () => {
    const silent = await sweepPlanted('silent');
    must(JSON.stringify(silent.silent) === '["GET /api/x"]' && silent.problems.length === 0, `a read drawn as a zero was not reported silent: ${JSON.stringify(silent)}`);
    const stating = await sweepPlanted('stating');
    must(stating.silent.length === 0 && stating.problems.length === 0, `a screen that states its failure was reported: ${JSON.stringify(stating)}`);
    const staticRetry = await sweepPlanted('staticRetry');
    must(staticRetry.problems.length === 1 && /holds 1 stated failure/.test(staticRetry.problems[0]), `a screen that already carries "Retry" was not refused as proving nothing: ${JSON.stringify(staticRetry)}`);
    must(staticRetry.silent.length === 1, 'and its silent read is still reported (the refused draw says no more of it than the healthy one)');
    const nothing = await sweepPlanted('nothing');
    must(nothing.problems.length === 1 && /vacuous/.test(nothing.problems[0]), `a screen that reads nothing was not refused as vacuous: ${JSON.stringify(nothing)}`);
  });
} finally {
  await browser.close();
}

run.finish(`clean at ${WIDTHS}`);
