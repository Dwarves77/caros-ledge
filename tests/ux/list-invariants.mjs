// UI-1 browser invariants (the layout half of INV-UI1-2, -3 and -4), shared by the UX smokes that mount a list or band tiles. `listInvariants` runs in the page (page.evaluate) and returns the offences it can see:
//  INV-UI1-2  no list-row text is in capitals (a text node of four or more letters that renders all-capital) except the jurisdiction code; band names and eyebrows are not inside a row.
//  INV-UI1-3  at 375 and 768 a row carries at most one meta line under the title and one due/tier line (no wrapped second line of either).
//  INV-UI1-4  no band tile truncates: its label and window have scrollWidth equal to clientWidth, and the window sits under the label.
//  U4         a chip, a count or the meta line is never clipped inside itself.
export function listInvariants(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    const visible = (el) => el.getClientRects().length > 0;
    const tag = (el) => `${el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 28)}"`;
    const rows = [...document.querySelectorAll('[data-part="list-row"]')].filter(visible);
    for (const row of rows) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        const text = (n.textContent || '').trim();
        if (!text || !parent || !visible(parent) || parent.closest('.cl-row-juris') || getComputedStyle(parent).display === 'none') continue;
        const shown = getComputedStyle(parent).textTransform === 'uppercase' ? text.toUpperCase() : text;
        const letters = shown.replace(/[^A-Za-z]/g, '');
        if (letters.length >= 4 && shown === shown.toUpperCase()) out.push(`INV-UI1-2 capitals in a row: "${shown.slice(0, 40)}"`);
      }
      if (vw < 1024) {
        const meta = row.querySelector('.cl-row-meta-tags');
        if (meta && visible(meta)) {
          const lh = parseFloat(getComputedStyle(meta).lineHeight) || parseFloat(getComputedStyle(meta).fontSize) * 1.3;
          const lines = Math.round(meta.getBoundingClientRect().height / lh);
          if (lines > 1) out.push(`INV-UI1-3 meta line is ${lines} lines: ${tag(meta)}`);
        }
        const line2 = row.querySelector('.cl-row-line2');
        // One line means every item shares a horizontal band: the lowest top is above the highest bottom's start (items are centred, so their tops differ by height).
        const boxes = [...line2.children].filter((c) => visible(c) && getComputedStyle(c).position !== 'absolute').map((c) => c.getBoundingClientRect());
        if (boxes.length && Math.max(...boxes.map((r) => r.top)) >= Math.min(...boxes.map((r) => r.bottom)) - 0.5) out.push('INV-UI1-3 the due/tier line wraps onto a second line');
      }
    }
    for (const el of document.querySelectorAll('.cl-tag-chip, .cl-bias-more, .cl-row-meta-mobile, .cl-row-meta-text')) {
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
