// UI-1 browser invariants (the layout half of INV-UI1-2, -3 and -4), shared by the UX smokes that mount a list or band tiles. `listInvariants` runs in the page (page.evaluate) and returns the offences it can see:
//  INV-UI1-2  no list-row text is in capitals (a text node of four or more letters that renders all-capital) except the jurisdiction code; band names and eyebrows are not inside a row.
//  INV-ROWS-2 (ROWS-1) a row is a title of at most two lines, one stored line and one meta line, at every width, and nothing in the meta line is cut inside itself.
//  INV-UI1-4  no band tile truncates: its label and window have scrollWidth equal to clientWidth, and the window sits under the label.
//  U4         a chip or the date is never clipped inside itself.
import { join } from 'node:path';

import { wholePageScreenshot } from '../parity/capture.mjs';

/** ROWS-1 R3/R6: prints the line counts of the rows on the page at 375 (the report's measurement table) and, with ROWS_SHOTS=<dir>, saves a whole-page screenshot at 375 and 1280 under `<name>-<width>.png`. */
export async function rowReport(page, where, name) {
  const r = await page.evaluate(() => {
    const lines = (el) => (el ? Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3)) : 0);
    const rows = [...document.querySelectorAll('[data-part="list-row"]')].filter((el) => el.getClientRects().length > 0);
    const max = (sel) => Math.max(0, ...rows.map((row) => lines(row.querySelector(sel))));
    return { rows: rows.length, title: max('.cl-row-title'), summary: max('.cl-row-summary'), meta: max('.cl-row-meta') };
  });
  const viewport = page.viewportSize();
  if (r.rows && viewport.width === 375) console.log(`rows ${where}: ${r.rows} rows, title max ${r.title} lines, summary max ${r.summary}, meta max ${r.meta}`);
  if (process.env.ROWS_SHOTS && name && (viewport.width === 375 || viewport.width === 1280)) await wholePageScreenshot(page, viewport, join(process.env.ROWS_SHOTS, `${name}-${viewport.width}.png`));
}

export function listInvariants(page) {
  return page.evaluate(() => {
    const out = [];
    const visible = (el) => el.getClientRects().length > 0;
    const tag = (el) => `${el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 28)}"`;
    const rows = [...document.querySelectorAll('[data-part="list-row"]')].filter(visible);
    for (const row of rows) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        const text = (n.textContent || '').trim();
        if (!text || !parent || !visible(parent) || parent.closest('[data-field="jurisdiction"]') || getComputedStyle(parent).display === 'none') continue;
        const shown = getComputedStyle(parent).textTransform === 'uppercase' ? text.toUpperCase() : text;
        const letters = shown.replace(/[^A-Za-z]/g, '');
        if (letters.length >= 4 && shown === shown.toUpperCase()) out.push(`INV-UI1-2 capitals in a row: "${shown.slice(0, 40)}"`);
      }
      // INV-ROWS-2 (ROWS-1): the short name is at most two lines, the stored line is one, the meta line is one and nothing in it is cut inside itself, at every width.
      const lines = (el) => Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3));
      const title = row.querySelector('.cl-row-title');
      const summary = row.querySelector('.cl-row-summary');
      const meta = row.querySelector('.cl-row-meta');
      if (title && lines(title) > 2) out.push(`INV-ROWS-2 title is ${lines(title)} lines: ${tag(title)}`);
      if (summary && lines(summary) > 1) out.push(`INV-ROWS-2 summary is ${lines(summary)} lines: ${tag(summary)}`);
      if (meta && (meta.scrollWidth > meta.clientWidth + 1 || lines(meta) > 1)) out.push(`INV-ROWS-2 meta line wraps or is cut (${meta.scrollWidth} in ${meta.clientWidth}): ${tag(meta)}`);
    }
    for (const el of document.querySelectorAll('.cl-tag-chip, .cl-row-more, .cl-row-due')) {
      if (visible(el) && el.closest('[data-part="list-row"]') && el.scrollWidth > el.clientWidth + 1) out.push(`U4 clipped inside itself: ${tag(el)} needs ${el.scrollWidth}, has ${el.clientWidth}`);
    }
    for (const tile of document.querySelectorAll('.cl-band-tile')) {
      if (!visible(tile)) continue;
      for (const el of [tile, ...tile.querySelectorAll('.cl-band-tile-label, .cl-band-tile-window')]) {
        if (el.scrollWidth > el.clientWidth + 1) out.push(`INV-UI1-4 band tile truncates: ${tag(el)} needs ${el.scrollWidth}, has ${el.clientWidth}`);
      }
      const label = tile.querySelector('.cl-band-tile-label');
      const win = tile.querySelector('.cl-band-tile-window');
      if (label && win && win.getBoundingClientRect().top < label.getBoundingClientRect().bottom - 1) out.push(`INV-UI1-4 band name and window share a line: ${tag(tile)}`);
    }
    return out;
  });
}
