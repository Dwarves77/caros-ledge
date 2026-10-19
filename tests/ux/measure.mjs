// The in-page measurement shared by the UX smokes: runs in the browser (page.evaluate) and returns the offences for one mounted fixture page.
// `rows` also checks the 100-row list fixture (only the main fixture page has it).
export function measure(opts = { rows: true }) {
  const out = [];
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);

  // Overflow: any box whose right edge passes the viewport, unless a declared sideways strip carries it.
  for (const el of document.querySelectorAll('[data-fx] *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !el.closest('[data-guard-strip],.cl-sr-only,.cl-virtual-item,.leaflet-container')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') out.push(`overflow: ${label(el)} right ${Math.round(r.right)} > ${vw}`);
    }
  }

  // A page frame is a grid whose second track is the rail: a frame with no rail child must not reserve that track (P2-15e: Community lost 328 px of width at 1280 to an empty rail column).
  for (const frame of document.querySelectorAll('[data-guard-frame]')) {
    if (!frame.getClientRects().length) continue;
    const tracks = getComputedStyle(frame).gridTemplateColumns.split(' ').filter(Boolean).length;
    if (tracks > frame.children.length) out.push(`page frame reserves ${tracks - frame.children.length} empty column track(s): ${tracks} tracks for ${frame.children.length} child(ren) at ${vw}px`);
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
  if (opts.rows) {
    const rows = document.querySelectorAll('[data-fx="rows"] .cl-list-row').length;
    if (rows !== 100) out.push(`expected 100 fixture rows, found ${rows}`);
    const withStyleAttrBytes = [...document.querySelectorAll('[data-fx="rows"] .cl-list-row')].reduce((n, el) => n + el.outerHTML.length, 0);
    if (withStyleAttrBytes / Math.max(rows, 1) > 6000) out.push(`a row weighs ${Math.round(withStyleAttrBytes / rows)} bytes of markup`);
  }
  return out;
}


// The real hit area of every element matching `selector` (P2-15m, design rulings 2026-10-18 items 21 and 40): found by probing elementFromPoint outward from the element's centre, so a padding or
// pseudo-element hit box counts and a bare 24 px box does not. Runs in the browser (page.evaluate(hitArea, selector)). Returns one record per visible match:
// { label, layoutH, hitW, hitH } where layoutH is the box's own height (a hit box must not grow the line or row).
export function hitArea(selector) {
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const r0 = el.getBoundingClientRect();
    if (r0.width < 2 || r0.height < 2) continue;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), document.documentElement.clientWidth - 1);
    const cy = r.top + r.height / 2;
    const hits = (x, y) => {
      const t = document.elementFromPoint(x, y);
      return !!t && (t === el || el.contains(t));
    };
    const reach = (dx, dy) => {
      let n = 0;
      while (n < 80 && hits(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
      return n;
    };
    out.push({
      label: `${(el.textContent || '').trim().slice(0, 30)}`,
      layoutH: Math.round(r.height * 10) / 10,
      hitH: reach(0, -1) + reach(0, 1) + 1,
      hitW: Math.round(r.width),
    });
  }
  return out;
}
