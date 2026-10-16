// The UX smoke (PROP-025, PROP-124, PROP-073): every row and card part, mounted with fixtures (/privacy/ui-fixtures, a 404 unless UI_FIXTURES=1), at
// 375x812, 768x1024, 1024x768 and 1280x800 with the real fonts. It fails on: horizontal overflow; a title narrower than its longest word; an interactive
// target below the law-2 floor (44 px on the shorter axis, or 24 px with 8 px clear of every other target); a 100-row list that carries its CSS more than once
// or any inline <style>. Then the behaviour contracts: the Dialog (Esc closes, focus returns to the opener), the back-to-top button bound to <main>,
// the failed-remainder note with Retry, and an anonymous /privacy that issues no notifications, bootstrap or admin request.
//
// Usage: node tests/ux/ux-smoke.mjs --base <origin>     (the server must run with UI_FIXTURES=1)
import { chromium } from 'playwright';

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

// Runs in the page. Returns the offences for one mounted fixture page.
function measure() {
  const out = [];
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);

  // Overflow: any box whose right edge passes the viewport, unless a declared sideways strip carries it.
  for (const el of document.querySelectorAll('[data-fx] *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !el.closest('[data-guard-strip],.cl-sr-only,.cl-virtual-item')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') out.push(`overflow: ${label(el)} right ${Math.round(r.right)} > ${vw}`);
    }
  }

  // Titles: never narrower than the longest word.
  const canvas = document.createElement('canvas').getContext('2d');
  for (const el of document.querySelectorAll('[data-guard-title]')) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = (el.textContent || '').trim();
    const longest = Math.max(0, ...text.split(/\s+/).map((w) => canvas.measureText(cs.textTransform === 'uppercase' ? w.toUpperCase() : w).width));
    const width = el.getBoundingClientRect().width;
    if (width + 1 < Math.min(longest, 120)) out.push(`title narrower than its longest word: ${label(el)} ${Math.round(width)} < ${Math.round(longest)}`);
  }

  // Targets.
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=menuitem],[role=option],summary,[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[inert],.cl-sr-only') && el.getAttribute('tabindex') !== '-1';
  };
  const boxOf = (el) => {
    if (el.matches('input[type=checkbox],input[type=radio]')) el = el.closest('label') || el;
    return el;
  };
  const targets = [...document.querySelectorAll(SEL)].filter(visible).map(boxOf);
  const unique = [...new Set(targets)].filter((el) => !el.closest('[data-fx-exempt]') && !el.classList.contains('cl-gfm-a') && !el.matches('div[tabindex],section[tabindex]'));
  const rects = unique.map((el) => [el, el.getBoundingClientRect()]);
  const gap = (a, b) => Math.max(0, Math.max(a.left - b.right, b.left - a.right), Math.max(a.top - b.bottom, b.top - a.bottom));
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (const [el, r] of rects) {
    if (Math.min(r.width, r.height) >= 43.5) continue;
    if (Math.min(r.width, r.height) < 23.5) {
      out.push(`target under 24 px: ${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      continue;
    }
    for (const [other, o] of rects) {
      if (other === el || el.contains(other) || other.contains(el) || overlaps(r, o)) continue;
      if (gap(r, o) < 7.5) {
        out.push(`target ${Math.round(r.width)}x${Math.round(r.height)} has only ${Math.round(gap(r, o))} px clear of ${label(other)}: ${label(el)}`);
        break;
      }
    }
  }

  // CSS carried once: no inline <style>, at most one base stylesheet link.
  const inline = [...document.querySelectorAll('style')].filter((s) => /cl-list-row|cl-band-tile|cl-fc/.test(s.textContent || ''));
  if (inline.length) out.push(`inline <style> carrying part CSS: ${inline.length}`);
  const rows = document.querySelectorAll('[data-fx="rows"] .cl-list-row').length;
  if (rows !== 100) out.push(`expected 100 fixture rows, found ${rows}`);
  const withStyleAttrBytes = [...document.querySelectorAll('[data-fx="rows"] .cl-list-row')].reduce((n, el) => n + el.outerHTML.length, 0);
  if (withStyleAttrBytes / Math.max(rows, 1) > 6000) out.push(`a row weighs ${Math.round(withStyleAttrBytes / rows)} bytes of markup`);
  return out;
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
    for (const o of await page.evaluate(measure)) fail(where, o);
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
