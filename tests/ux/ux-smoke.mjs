// The UX smoke (PROP-025, PROP-124, PROP-073): every row and card part, mounted with fixtures (/privacy/ui-fixtures, a 404 unless UI_FIXTURES=1), at
// 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on: horizontal overflow; a title narrower than its longest word; an interactive
// target below the law-2 floor (44 px on the shorter axis, or 24 px with 8 px clear of every other target); a 100-row list that carries its CSS more than once
// or any inline <style>. Then the behaviour contracts: the Dialog (Esc closes, focus returns to the opener), the back-to-top button bound to <main>,
// the failed-remainder note with Retry, and an anonymous /privacy that issues no notifications, bootstrap or admin request.
//
// Usage: node tests/ux/ux-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { chromium } from 'playwright';

import { measure } from './measure.mjs';

const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
];
const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base.startsWith('--')) throw new Error('usage: ux-smoke.mjs --base <origin>');

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);


// The matrix contracts (operator 2026-09-09): the card height is constant across arrival, a selected cell, compare mode and Esc; arrows move the selection and Home moves only; Esc closes; the dimension column stays
// pinned while the regions scroll; six regions scroll inside the card where five fit; the arrival state declares itself and the declaration goes when the reader acts.
async function matrixContracts(page, w, where) {
  const card = page.locator('[data-fx="matrix-six"] [data-audit="ops-matrix-card"]');
  const heights = [];
  const height = async () => Math.round((await card.boundingBox()).height);
  heights.push(['arrival', await height()]);
  if (!(await card.locator('[data-open-on-mount]').count())) fail(where, 'the arrival state is not declared');
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
  if (!(await pill.count())) return fail(where, 'the Fuels & SAF theme pill is missing');
  await pill.first().click();
  await page.waitForURL(/theme=fuels_saf/);
  if ((await page.getByRole('button', { name: /Clear theme/ }).count()) === 0) fail(where, 'a chosen theme offers no Clear theme');
  await page.goto(`${new URL(page.url()).origin}/privacy/ui-fixtures/surfaces?screen=research`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Research item actions' }).first().click();
  if (!(await page.getByRole('menuitem', { name: 'Copy link' }).count())) fail(where, 'the row menu offers no Copy link');
  await page.keyboard.press('Escape');
  if (!(await page.getByRole('link', { name: 'How impact is read →' }).count())) fail(where, 'the awareness note does not point at the legend');
}

const browser = await chromium.launch();
try {
  for (const [w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const where = `${w}x${h}`;
    const res = await page.goto(`${base}/privacy/ui-fixtures`, { waitUntil: 'networkidle' });
    if (!res || res.status() !== 200) {
      fail(where, `fixture page answered ${res?.status()}`);
      await ctx.close();
      continue;
    }
    await page.evaluate(() => document.fonts.ready);
    for (const o of await page.evaluate(measure, { rows: true })) fail(where, o);
    if (w === 375) {
      // The four band tiles sit in a 2x2 grid at 375.
      const tiles = await page.$$eval('[data-fx="tiles"] .cl-band-tile', (els) => els.map((e) => e.getBoundingClientRect().top));
      if (new Set(tiles.map((t) => Math.round(t))).size !== 2) fail(where, `band tiles are not 2x2: ${tiles.join(',')}`);
    }
    // The failed remainder says so, offers Retry, and the first page is not presented as the whole list.
    const note = await page.locator('[data-fx="surface"] [role=alert]').first().innerText();
    if (!/did not load/i.test(note) || !/Retry/.test(note)) fail(where, `the failed-remainder note is wrong: ${note}`);
    // Dialog focus contract.
    const opener = page.locator('#fx-open-dialog');
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
    await ctx.close();
  }

  // P2-12: the Research and Operations screens (the real parts and lists over fixtures) at the same four widths: law 2, overflow, titles, then the contracts of the matrix and the lists.
  for (const [w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const screen of ['parts', 'research', 'operations']) {
      const where = `${w}x${h} ${screen}`;
      const res = await page.goto(`${base}/privacy/ui-fixtures/surfaces?screen=${screen}`, { waitUntil: 'networkidle' });
      if (!res || res.status() !== 200) {
        fail(where, `fixture page answered ${res?.status()}`);
        continue;
      }
      await page.evaluate(() => document.fonts.ready);
      for (const o of await page.evaluate(measure, { rows: false })) fail(where, o);
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
    }
    for (const e of errors) fail(`${w}x${h}`, `page error: ${e}`);
    await ctx.close();
  }

  // Anonymous /privacy: the shell renders as the baseline does, but the page issues no notifications, bootstrap or admin request, and has a single main landmark.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const seen = [];
  page.on('request', (r) => seen.push(new URL(r.url()).pathname));
  await page.goto(`${base}/privacy`, { waitUntil: 'networkidle' });
  const bad = seen.filter((p) => /notifications|workspace\/bootstrap|\/api\/admin/.test(p));
  if (bad.length) fail('privacy', `an anonymous page issued ${bad.join(', ')}`);
  if ((await page.locator('main').count()) !== 1) fail('privacy', 'the page does not have exactly one main landmark');
  if (!(await page.locator('[data-part=nav-card]').count())) fail('privacy', 'the shell nav card is missing on /privacy');
  await ctx.close();
} finally {
  await browser.close();
}

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(`ux-smoke: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('ux-smoke: clean at 375x812, 768x1024, 1024x768, 1280x800');
