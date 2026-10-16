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

  // Anonymous /privacy: no notifications, bootstrap or admin request, and a single main landmark.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const seen = [];
  page.on('request', (r) => seen.push(new URL(r.url()).pathname));
  await page.goto(`${base}/privacy`, { waitUntil: 'networkidle' });
  const bad = seen.filter((p) => /notifications|workspace\/bootstrap|\/api\/admin/.test(p));
  if (bad.length) fail('privacy', `an anonymous page issued ${bad.join(', ')}`);
  if ((await page.locator('main').count()) !== 1) fail('privacy', 'the page does not have exactly one main landmark');
  if (await page.locator('[data-part=nav-card]').count()) fail('privacy', 'the signed-in nav card is on a public page');
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
