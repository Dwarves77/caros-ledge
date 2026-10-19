// The in-page measurement shared by the UX smokes and the parity capture: `measure` runs in the browser (page.evaluate) and returns the offences for one mounted page; `measurePage` is the Node side that hands it
// the exemption lists. The exemptions are DATA with a reason each (tests/ux/measure-exemptions.json, validated on load): no exemption lives in this function, so a class name cannot be added to a list unseen.
// `rows` also checks the 100-row list fixture (only the main fixture page has it). `scope` is the CSS selector the overflow scan walks: a fixture page is `[data-fx] *`, a real route is `body *`.
import { readFileSync } from 'node:fs';

const EXEMPTIONS_FILE = new URL('./measure-exemptions.json', import.meta.url);
const KINDS = ['overflow', 'target', 'collapsed'];
const MIN_REASON = 20;

/** Reads and validates the exemption lists: every kind present and non-empty, every entry a selector, a match mode and a reason. Throws on anything else. */
export function loadExemptions(file = EXEMPTIONS_FILE) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  for (const kind of KINDS) {
    if (!Array.isArray(json[kind]) || json[kind].length === 0) throw new Error(`measure-exemptions.json: "${kind}" must be a non-empty list`);
    for (const e of json[kind]) {
      if (typeof e.selector !== 'string' || !e.selector) throw new Error(`measure-exemptions.json: a "${kind}" entry has no selector`);
      if (e.match !== 'self' && e.match !== 'within') throw new Error(`measure-exemptions.json: "${e.selector}" must say match "self" or "within"`);
      if (typeof e.reason !== 'string' || e.reason.trim().length < MIN_REASON) throw new Error(`measure-exemptions.json: "${e.selector}" carries no reason (at least ${MIN_REASON} characters)`);
    }
  }
  return Object.fromEntries(KINDS.map((k) => [k, json[k]]));
}

/** A list row's title column is never narrower than this at 1024 px and up (about 22 characters of the row title type): V-9 found it at 119 px at 1280. */
export const TITLE_COLUMN_MIN = 160;

/** Measures the page in the browser with the repository's exemptions. */
export function measurePage(page, { rows = false, scope } = {}) {
  return page.evaluate(measure, { rows, scope, exempt: loadExemptions(), titleColumnMin: TITLE_COLUMN_MIN });
}

export function measure(opts) {
  if (!opts?.exempt) throw new Error('measure needs the exemption lists (use measurePage)');
  const scope = opts.scope ?? '[data-fx] *';
  const skipped = (kind, el) => opts.exempt[kind].some((e) => (e.match === 'within' ? el.closest(e.selector) : el.matches(e.selector)));
  const out = [];
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);

  // Overflow: any box whose right edge passes the viewport, unless a declared sideways strip carries it.
  for (const el of document.querySelectorAll(scope)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !skipped('overflow', el)) {
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

  // P2-15e: a card in a sideways strip keeps its declared width (a long unbreakable member title once stretched a theme card to 548 px and the strip clipped it); a timeline date is never cut by an ellipsis; a section title does not wrap while it fits alone on its line.
  for (const card of document.querySelectorAll('.cl-theme-card')) {
    const width = card.getBoundingClientRect().width;
    if (card.getClientRects().length && width > 262) out.push(`theme card stretched to ${Math.round(width)} px (declared 260)`);
  }
  for (const el of document.querySelectorAll('.cl-tl-date')) {
    if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) out.push(`timeline date clipped: "${(el.textContent || '').trim()}" needs ${el.scrollWidth} px, has ${el.clientWidth}`);
  }
  for (const rail of document.querySelectorAll('[data-notices-rail]')) {
    const r = rail.getBoundingClientRect();
    if (r.width && (r.left < 16 || r.right > vw - 16)) out.push(`recalculation notices card has no page gutter: ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
  }
  const headCanvas = document.createElement('canvas').getContext('2d');
  for (const title of document.querySelectorAll('.cl-section-head2 .cl-section-title')) {
    if (!title.getClientRects().length) continue;
    const cs = getComputedStyle(title);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    if (title.getBoundingClientRect().height < lineHeight * 1.5) continue;
    headCanvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = (title.textContent || '').trim();
    const natural = headCanvas.measureText(cs.textTransform === 'uppercase' ? text.toUpperCase() : text).width + (parseFloat(cs.letterSpacing) || 0) * text.length;
    const head = title.closest('.cl-section-head2');
    const room = head.clientWidth - 2 * (parseFloat(getComputedStyle(head).paddingLeft) || 0);
    if (natural <= room) out.push(`section title wraps although it fits alone: "${text}" ${Math.round(natural)} px in ${Math.round(room)} px`);
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

  // A list row's title column: the 1fr cell of the row grid. At 1024 px and up it keeps a readable measure (V-9: 119 px at 1280 with the filter rail beside it).
  if (vw >= 1024) {
    for (const title of document.querySelectorAll('[data-part="list-row"] [data-guard-title]')) {
      if (!title.getClientRects().length) continue;
      const column = Math.round(title.getBoundingClientRect().width);
      if (column < opts.titleColumnMin) out.push(`list title column squeezed to ${column} px at ${vw} px wide (floor ${opts.titleColumnMin}): ${label(title)}`);
    }
  }

  // Targets.
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=menuitem],[role=option],summary,[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[inert]') && el.getAttribute('tabindex') !== '-1';
  };
  const boxOf = (el) => {
    if (el.matches('input[type=checkbox],input[type=radio]')) el = el.closest('label') || el;
    return el;
  };
  // A focusable control collapsed to under 2 px is a target nobody can see or hit: an offence, unless an exemption names why it is hidden on purpose.
  for (const el of document.querySelectorAll(SEL)) {
    if (!el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hiddenOnPurpose = cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[inert],[hidden],[aria-hidden="true"]') || el.matches(':disabled') || el.getAttribute('tabindex') === '-1';
    if ((r.width < 2 || r.height < 2) && !hiddenOnPurpose && !skipped('collapsed', el)) out.push(`focusable control collapsed to ${Math.round(r.width)}x${Math.round(r.height)}: ${label(el)}`);
  }
  const targets = [...document.querySelectorAll(SEL)].filter(visible).map(boxOf);
  const unique = [...new Set(targets)].filter((el) => !skipped('target', el));
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
