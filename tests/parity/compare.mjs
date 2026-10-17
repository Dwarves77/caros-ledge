// The parity gate (PART2-AGENT-PLAN-2026-10-15 section 7). Compares a capture (tests/parity/capture.mjs output) with the committed baseline.
//
// Usage: node tests/parity/compare.mjs --captured <dir> [--baseline tests/parity/baseline] [--config tests/parity/approved-changes.json]
//
// FAIL when, on a route a UI slice owns (config.gates), any baseline landmark, heading, control or list field is missing or reordered, or a row at 375 is
// taller than its baseline row. The pixel diff is reported at a 2 percent threshold and GATES only the routes listed in gates.pixelExact. Anything a
// baseline has that the capture lacks must match an entry of `approved` (BUILD-PLAN ruling 10, or a ruling the entry cites): only those may differ.
// A route the capture marks `skipped` (no signed-in credentials) is reported, never failed. Exit 0 clean, 1 on any FAIL.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { chromium } from 'playwright';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEEP = new Set(['privacy@carosledge.com']);
// The baseline was sanitized (every email, placeholders included, became smoke@example.invalid); the capture gets the same treatment before comparing.
const clean = (s) => String(s ?? '').replace(EMAIL, (m) => (KEEP.has(m) ? m : 'smoke@example.invalid')).replace(/\s+/g, ' ').trim();
// A count a page may or may not draw ("Watchlist0" at baseline, "Watchlist" now) is dropped when it trails a letter.
const uncount = (s) => clean(s).replace(/\d[\d,]*/g, '#').replace(/(?<=[A-Za-z])#$/, '');
const PIXEL_THRESHOLD = 0.02;
// IMP-062: the diff images land beside the capture's report so the parity job uploads them as an artifact.
const DIFF_DIR = 'parity-diff';

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

// A waiver of kind 'until-migration' (with `migration` and optionally `on`: landmark, heading or control) covers a difference that exists only because production carries no new migration before the
// cutover window. It is counted apart from the look/ruling waivers, and tree-checks retires it once supabase/migrations/APPLIED.json lists the migration.
const untilMigration = (approved, route, kind, text) => approved.find((a) => a.kind === 'until-migration' && a.route === route && (!a.on || a.on === kind) && (a.match === '*' || new RegExp(a.match).test(text)));
const isApproved = (approved, route, kind, text) => approved.some((a) => a.route === route && a.kind === kind && (a.match === '*' || new RegExp(a.match).test(text)));

export function compareRecord(route, viewport, base, cap, approved) {
  const fails = [];
  const used = [];
  const until = [];
  const sort = (kind, m, line) => {
    if (isApproved(approved, route, kind, m)) return used.push(line);
    const w = untilMigration(approved, route, kind, m);
    return w ? until.push({ line, migration: w.migration }) : fails.push(line);
  };
  const check = (kind, baseItems, capItems, key, show) => {
    const { missing, reordered } = subsequence(baseItems, capItems, key);
    for (const m of missing) sort(kind, m, `${kind} missing: ${m}`);
    for (const m of reordered) sort(kind, m, `${kind} reordered: ${m}`);
    void show;
  };
  check('landmark', base.landmarks ?? [], cap.landmarks ?? [], (l) => l.role);
  // Counts are data, not design: every integer run in a name ("+ 18 more", "GLOBAL16", "Regulations1,320") compares as "#".
  check('heading', base.headings ?? [], cap.headings ?? [], (h) => `${h.level}:${uncount(h.text)}`);
  const ctl = (c) => `${c.role}:${uncount(c.name)}`;
  check('control', base.controls ?? [], cap.controls ?? [], ctl);
  const baseRows = base.rows?.items ?? [];
  const capRows = cap.rows?.items ?? [];
  check('row', baseRows, capRows, (r) => `${r.tag}:${clean(r.text).slice(0, 80)}`);
  if (viewport.startsWith('375')) {
    const byText = new Map(capRows.map((r) => [`${r.tag}:${clean(r.text).slice(0, 80)}`, r.height]));
    for (const r of baseRows) {
      const h = byText.get(`${r.tag}:${clean(r.text).slice(0, 80)}`);
      if (h !== undefined && h > r.height + 1) {
        const line = `row taller at 375: ${clean(r.text).slice(0, 40)} (${h.toFixed(1)} > ${r.height.toFixed(1)})`;
        (isApproved(approved, route, 'row-height', clean(r.text)) ? used : fails).push(line);
      }
    }
  }
  return { fails, used, until };
}

// A frame route proves the shell only: its controls, headings and landmarks are limited to the shell's, the rest is page body that the full gate checks.
// `config.frameLandmarks[viewport]` is the shell's landmark roles in order (written down in approved-changes.json, from the dashboard baseline).
export function scopeFrame(base, config, viewport) {
  const shellRoles = config.frameLandmarks[viewport] ?? [];
  const body = (base.landmarks ?? []).filter((l) => !shellRoles.includes(l.role)).map((l) => l.role);
  const scoped = {
    ...base,
    rows: { items: [] },
    landmarks: shellRoles.map((role) => ({ role })),
    controls: base.controls.filter((x) => config.frameControls.some((re) => new RegExp(re).test(`${x.role}:${x.name}`))),
    headings: base.headings.filter((h) => config.frameHeadings.includes(h.text)),
  };
  return { scoped, notes: [...new Set(body)].map((role) => `body landmark, checked at full: ${role}`) };
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
        // IMP-062: the diff image a reviewer looks at: the capture faded, every differing pixel red.
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const og = out.getContext('2d');
        const img = og.createImageData(w, h);
        for (let i = 0; i < da.length; i += 4) {
          const differs = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48;
          if (differs) diff += 1;
          img.data[i] = differs ? 255 : Math.round((db[i] + 765) / 4);
          img.data[i + 1] = differs ? 0 : Math.round((db[i + 1] + 765) / 4);
          img.data[i + 2] = differs ? 0 : Math.round((db[i + 2] + 765) / 4);
          img.data[i + 3] = 255;
        }
        og.putImageData(img, 0, 0);
        return { ratio: diff / (w * h), sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], image: diff > 0 ? out.toDataURL('image/png') : null };
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
                    const { scoped, notes } = frame.has(route.name) ? scopeFrame(b, config, viewport) : { scoped: b, notes: [] };
          for (const n of notes) lines.push(`${viewport}: ${n}`);
          const { fails, used, until } = compareRecord(route.name, viewport, scoped, c, approved);
          for (const f of fails) lines.push(`${viewport}: ${f}`);
          if (used.length) lines.push(`${viewport}: approved differences used: ${used.length}`);
          for (const m of [...new Set(until.map((u) => u.migration))]) lines.push(`${viewport}: waived until migration ${m} is applied in production: ${until.filter((u) => u.migration === m).length}`);
          routeFail ||= fails.length > 0;
        }
        const pngA = `${args.baseline}/${stem}.png`;
        const pngB = `${args.captured}/${stem}.png`;
        if (await readFile(pngA).then(() => true, () => false)) {
          const d = await pixelDiff(browser, pngA, pngB).catch((e) => ({ error: String(e) }));
          if (d.error) lines.push(`${viewport}: pixel compare error ${d.error}`);
          else {
            const over = d.ratio > PIXEL_THRESHOLD;
            if (d.image) {
              await mkdir(DIFF_DIR, { recursive: true });
              await writeFile(`${DIFF_DIR}/${stem}.png`, Buffer.from(d.image.split(',')[1], 'base64'));
            }
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
