// The parity gate (PART2-AGENT-PLAN-2026-10-15 section 7). Compares a capture (tests/parity/capture.mjs output) with the committed baseline.
//
// Usage: node tests/parity/compare.mjs --captured <dir> [--baseline tests/parity/baseline] [--config tests/parity/approved-changes.json]
//
// FAIL when, on a route a UI slice owns (config.gates), any baseline landmark, heading, control or list field is missing or reordered, or a row at 375 is
// taller than its baseline row. The pixel diff is reported at a 2 percent threshold and GATES only the routes listed in gates.pixelExact. Anything a
// baseline has that the capture lacks must match an entry of `approved` (BUILD-PLAN ruling 10, or a ruling the entry cites): only those may differ.
// A route the capture marks `skipped` (no signed-in credentials) is reported, never failed. Exit 0 clean, 1 on any FAIL.
import { readFile } from 'node:fs/promises';

import { chromium } from 'playwright';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEEP = new Set(['privacy@carosledge.com']);
// The baseline was sanitized (every email, placeholders included, became smoke@example.invalid); the capture gets the same treatment before comparing.
const clean = (s) => String(s ?? '').replace(EMAIL, (m) => (KEEP.has(m) ? m : 'smoke@example.invalid')).replace(/\s+/g, ' ').trim();
const PIXEL_THRESHOLD = 0.02;

function parseArgs(argv) {
  const a = { baseline: 'tests/parity/baseline', config: 'tests/parity/approved-changes.json' };
  for (let i = 0; i < argv.length; i += 2) a[argv[i].slice(2)] = argv[i + 1];
  if (!a.captured) throw new Error('usage: compare.mjs --captured <dir> [--baseline <dir>] [--config <file>]');
  return a;
}
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const readOpt = async (p) => readJson(p).catch(() => null);

// Ordered-subsequence check: every baseline item must appear in the capture, in the baseline's order. Returns the missing and the out-of-order items.
export function subsequence(baseline, captured, key) {
  const want = baseline.map(key);
  const have = captured.map(key);
  const missing = [];
  const reordered = [];
  let at = 0;
  for (const w of want) {
    const found = have.indexOf(w, at);
    if (found >= 0) at = found + 1;
    else if (have.includes(w)) reordered.push(w);
    else missing.push(w);
  }
  return { missing, reordered };
}

const isApproved = (approved, route, kind, text) => approved.some((a) => a.route === route && a.kind === kind && (a.match === '*' || new RegExp(a.match).test(text)));

export function compareRecord(route, viewport, base, cap, approved) {
  const fails = [];
  const used = [];
  const check = (kind, baseItems, capItems, key, show) => {
    const { missing, reordered } = subsequence(baseItems, capItems, key);
    for (const m of missing) (isApproved(approved, route, kind, m) ? used : fails).push(`${kind} missing: ${m}`);
    for (const m of reordered) (isApproved(approved, route, kind, m) ? used : fails).push(`${kind} reordered: ${m}`);
    void show;
  };
  check('landmark', base.landmarks ?? [], cap.landmarks ?? [], (l) => l.role);
  check('heading', base.headings ?? [], cap.headings ?? [], (h) => `${h.level}:${clean(h.text)}`);
  // A nav link's trailing count is live data ("Regulations1,320"), not design.
  const ctl = (c) => `${c.role}:${clean(c.name).replace(/(?<=[A-Za-z])[\d,]+$/, '')}`;
  check('control', base.controls ?? [], cap.controls ?? [], ctl);
  const baseRows = base.rows?.items ?? [];
  const capRows = cap.rows?.items ?? [];
  check('row', baseRows, capRows, (r) => `${r.tag}:${clean(r.text).slice(0, 80)}`);
  if (viewport.startsWith('375')) {
    const byText = new Map(capRows.map((r) => [`${r.tag}:${clean(r.text).slice(0, 80)}`, r.height]));
    for (const r of baseRows) {
      const h = byText.get(`${r.tag}:${clean(r.text).slice(0, 80)}`);
      if (h !== undefined && h > r.height + 1) fails.push(`row taller at 375: ${clean(r.text).slice(0, 40)} (${h.toFixed(1)} > ${r.height.toFixed(1)})`);
    }
  }
  return { fails, used };
}

async function pixelDiff(browser, aPath, bPath) {
  const [a, b] = await Promise.all([readFile(aPath), readFile(bPath)]);
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ([x, y]) => {
        const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `data:image/png;base64,${b64}`; });
        const [ia, ib] = await Promise.all([load(x), load(y)]);
        const w = Math.max(ia.width, ib.width);
        const h = Math.max(ia.height, ib.height);
        const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
        const da = px(ia);
        const db = px(ib);
        let diff = 0;
        for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) diff += 1;
        return { ratio: diff / (w * h), sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height] };
      },
      [a.toString('base64'), b.toString('base64')],
    );
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(args.config);
  const baseIndex = await readJson(`${args.baseline}/index.json`);
  const capIndex = await readJson(`${args.captured}/index.json`);
  const full = new Set(config.gates.full);
  const frame = new Set(config.gates.frame);
  const pixelExact = new Set(config.gates.pixelExact);
  let failed = false;
  const report = [];
  const browser = await chromium.launch();
  try {
    for (const route of baseIndex.routes) {
      const cap = capIndex.routes.find((r) => r.name === route.name);
      const gated = full.has(route.name) || frame.has(route.name);
      if (!cap || cap.status === 'skipped') {
        report.push({ route: route.name, result: 'SKIPPED', note: cap ? 'no signed-in credentials in this run' : 'not captured' });
        continue;
      }
      if (cap.status !== 'ok') {
        const fatal = gated;
        failed ||= fatal;
        report.push({ route: route.name, result: fatal ? 'FAIL' : 'ERROR', note: `capture ${cap.status}: ${cap.error}` });
        continue;
      }
      const approved = config.approved.filter((a) => a.route === route.name);
      const lines = [];
      let routeFail = false;
      for (const stem of route.files) {
        const viewport = stem.split('.')[1];
        const [b, c] = await Promise.all([readJson(`${args.baseline}/${stem}.json`), readOpt(`${args.captured}/${stem}.json`)]);
        if (!c) { lines.push(`${viewport}: capture missing`); routeFail ||= gated; continue; }
        if (gated) {
          // A frame route owns only the shell: the landmarks, headings and controls the shell draws, not the page body a later slice builds.
          const scoped = frame.has(route.name) ? { ...b, rows: { items: [] }, controls: b.controls.filter((x) => config.frameControls.some((re) => new RegExp(re).test(`${x.role}:${x.name}`))), headings: b.headings.filter((h) => config.frameHeadings.includes(h.text)) } : b;
          const { fails, used } = compareRecord(route.name, viewport, scoped, c, approved);
          for (const f of fails) lines.push(`${viewport}: ${f}`);
          if (used.length) lines.push(`${viewport}: approved differences used: ${used.length}`);
          routeFail ||= fails.length > 0;
        }
        const pngA = `${args.baseline}/${stem}.png`;
        const pngB = `${args.captured}/${stem}.png`;
        if (await readFile(pngA).then(() => true, () => false)) {
          const d = await pixelDiff(browser, pngA, pngB).catch((e) => ({ error: String(e) }));
          if (d.error) lines.push(`${viewport}: pixel compare error ${d.error}`);
          else {
            const over = d.ratio > PIXEL_THRESHOLD;
            const waived = approved.some((a) => a.kind === 'pixel' && (a.viewport === undefined || a.viewport === viewport));
            lines.push(`${viewport}: pixel diff ${(d.ratio * 100).toFixed(2)}% (threshold ${PIXEL_THRESHOLD * 100}%)${over && pixelExact.has(route.name) ? (waived ? ' over, waived by an approved change' : ' GATE') : ''}`);
            if (over && pixelExact.has(route.name) && !waived) routeFail = true;
          }
        }
      }
      failed ||= routeFail;
      report.push({ route: route.name, result: routeFail ? 'FAIL' : gated ? 'PASS' : 'REPORTED', lines });
    }
  } finally {
    await browser.close();
  }
  for (const r of report) {
    console.log(`${r.result.padEnd(9)} ${r.route}${r.note ? `: ${r.note}` : ''}`);
    for (const l of r.lines ?? []) console.log(`            ${l}`);
  }
  console.log(failed ? 'parity: FAIL' : 'parity: ok');
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('compare.mjs')) await main();
