// The parity gate (PART2-AGENT-PLAN-2026-10-15 section 7). Compares a capture (tests/parity/capture.mjs output) with the committed baseline.
//
// Usage: node tests/parity/compare.mjs --captured <dir> [--baseline tests/parity/baseline] [--config tests/parity/approved-changes.json] [--routes tests/parity/routes.json]
//
// The gate can fail. It ends with `compared N of M gated routes` and exits 1 unless every gated route was compared; a gated route that was not compared is a FAIL unless approved-changes.json names it
// in `skippable` with a reason (a baseline that cannot exist yet), or the capture says it was a signed-out run (`signed_out_only`: member routes were never requested). Every name in routes.json is gated
// or exempt with a reason, so a new route cannot sit outside the gate unseen.
//
// On a gated route FAIL means: a baseline landmark (role and name), heading, control, list container or list row is missing or reordered; a row at 375 is taller than its baseline row; a list route's baseline
// holds no rows; the capture holds an offence the layout measure found (a target under the law-2 floor, overflow, a squeezed title); the page was taller than the screenshot ceiling; a pixelExact route's
// image differs by more than 2 percent, or either image cannot be read. Anything a baseline has that the capture lacks must match an entry of `approved` (a look, security or until-migration ruling).
// A baseline written under another capture contract is not compared: the run fails and names the recapture. Exit 0 clean, 1 on any FAIL. No browser is needed: images are read in Node (png.mjs).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { CAPTURE_CONTRACT } from './contract.mjs';
import { pixelDiff } from './png.mjs';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEEP = new Set(['privacy@carosledge.com']);
// The baseline was sanitized (every email, placeholders included, became smoke@example.invalid); the capture gets the same treatment before comparing.
// The account name token is the local part of LIVE_SMOKE_EMAIL (never a literal here); the baseline carries it as "smoke" in any case, so both sides map to lowercase smoke.
const nameToken = () => (process.env.LIVE_SMOKE_EMAIL ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => {
  let t = String(s ?? '').replace(EMAIL, (m) => (KEEP.has(m) ? m : 'smoke@example.invalid'));
  const token = nameToken();
  if (token.length >= 4) t = t.replace(new RegExp(token, 'gi'), 'smoke');
  return t.replace(/smoke/gi, 'smoke').replace(/\s+/g, ' ').trim();
};
// A count a page may or may not draw ("Watchlist0" at baseline, "Watchlist" now) is dropped when it trails a letter.
const uncount = (s) => clean(s).replace(/\d[\d,]*/g, '#').replace(/(?<=[A-Za-z])#$/, '');
const PIXEL_THRESHOLD = 0.02;
// IMP-062: the diff images land beside the capture's report so the parity job uploads them as an artifact.
const DIFF_DIR = 'parity-diff';
const MIN_REASON = 20;

function parseArgs(argv) {
  const a = { baseline: 'tests/parity/baseline', config: 'tests/parity/approved-changes.json', routes: 'tests/parity/routes.json' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`usage: compare.mjs --captured <dir> [--baseline <dir>] [--config <file>] [--routes <file>] (bad argument ${argv[i] ?? '<none>'})`);
    a[argv[i].slice(2)] = argv[i + 1];
  }
  if (!a.captured) throw new Error('usage: compare.mjs --captured <dir> [--baseline <dir>] [--config <file>] [--routes <file>]');
  return a;
}
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const readOpt = async (p) => readJson(p).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));

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
// Waiver usage: every waiver id that covered a difference in this run lands here, so the report can end with the waivers that covered nothing (a waiver must match a current difference).
export const USED_WAIVERS = new Set();
const hit = (a) => { if (a) USED_WAIVERS.add(a.id); return a; };
const untilMigration = (approved, route, kind, text) => hit(approved.find((a) => a.kind === 'until-migration' && a.route === route && (!a.on || a.on === kind) && (a.match === '*' || new RegExp(a.match).test(text))));
// A waiver of kind 'order' (route, `match` on the control name, ruling) covers a "control reordered" line for a matching control where the old tree left the order unspecified (no secondary key, proven by file:line in the ruling)
// and the new tree's deterministic rule stands. It waives ORDER ONLY: a missing or renamed control under the same pattern is not reordered, it fails.
const orderWaived = (approved, route, text) => Boolean(hit(approved.find((a) => a.kind === 'order' && a.route === route && new RegExp(a.match).test(text))));
const isApproved = (approved, route, kind, text) => Boolean(hit(approved.find((a) => a.route === route && a.kind === kind && (a.match === '*' || new RegExp(a.match).test(text)))));

// `dataNames` ({route, match, keep, reason}): a control whose name is derived from live data (a count, then words drawn from the corpus) is compared by its stable prefix `keep`, on both sides, before the
// subsequence check. Counts are already normalised; words derived from data are the same class. The reason is recorded in the report line.
export function compareRecord(route, viewport, base, cap, approved, dataNames = []) {
  const fails = [];
  const used = [];
  const until = [];
  const sort = (kind, m, line) => {
    if (isApproved(approved, route, kind, m)) return used.push(line);
    const w = untilMigration(approved, route, kind, m);
    return w ? until.push({ line, migration: w.migration }) : fails.push(line);
  };
  const check = (kind, baseItems, capItems, key) => {
    const { missing, reordered } = subsequence(baseItems, capItems, key);
    for (const m of missing) sort(kind, m, `${kind} missing: ${m}`);
    for (const m of reordered) {
      if (kind === 'control' && orderWaived(approved, route, m)) used.push(`${kind} reordered: ${m}`);
      else sort(kind, m, `${kind} reordered: ${m}`);
    }
  };
  // A landmark is its role and its name: a region renamed or swapped for another of the same role is a difference, and a missing one is told apart from a reordered one.
  check('landmark', base.landmarks ?? [], cap.landmarks ?? [], (l) => `${l.role}:${uncount(l.name)}`);
  // Counts are data, not design: every integer run in a name ("+ 18 more", "GLOBAL16", "Regulations1,320") compares as "#".
  check('heading', base.headings ?? [], cap.headings ?? [], (h) => `${h.level}:${uncount(h.text)}`);
  const names = dataNames.filter((d) => d.route === route);
  const stable = (name) => {
    for (const d of names) if (new RegExp(d.match).test(name)) return name.match(new RegExp(d.keep))?.[0] ?? name;
    return name;
  };
  const ctl = (c) => `${c.role}:${stable(uncount(c.name))}`;
  if (names.length && (base.controls ?? []).some((c) => names.some((d) => new RegExp(d.match).test(uncount(c.name))))) used.push(`data names: ${names[0].reason}`);
  check('control', base.controls ?? [], cap.controls ?? [], ctl);
  const baseRows = base.rows?.items ?? [];
  const capRows = cap.rows?.items ?? [];
  // The lists themselves: each baseline container that held rows still exists, in order, and its rows are all there, in the baseline's order.
  check('list container', (base.rows?.containers ?? []).filter((c) => c.count > 0), cap.rows?.containers ?? [], (c) => uncount(c.label));
  // A row key carries live counts too ("2/7 sourced · 985 regs"): the same normalisation as names.
  const rowKey = (r) => `${r.tag}:${uncount(r.text).slice(0, 80)}`;
  check('row', baseRows, capRows, rowKey);
  if (viewport.startsWith('375')) {
    const byText = new Map(capRows.map((r) => [rowKey(r), r.height]));
    for (const r of baseRows) {
      const h = byText.get(rowKey(r));
      if (h !== undefined && h > r.height + 1) {
        const line = `row taller at 375: ${clean(r.text).slice(0, 40)} (${h.toFixed(1)} > ${r.height.toFixed(1)})`;
        (isApproved(approved, route, 'row-height', clean(r.text)) ? used : fails).push(line);
      }
    }
  }
  return { fails, used, until };
}

// A frame route proves the shell only: its controls, headings and landmarks are limited to the shell's, the rest is page body that the full gate checks.
// `config.frameLandmarks[viewport]` is the shell's landmark roles in order (written down in approved-changes.json, from the dashboard baseline); each keeps the name the baseline gave it.
export function scopeFrame(base, config, viewport) {
  const shellRoles = config.frameLandmarks[viewport] ?? [];
  const body = (base.landmarks ?? []).filter((l) => !shellRoles.includes(l.role)).map((l) => l.role);
  const scoped = {
    ...base,
    rows: { items: [], containers: [] },
    landmarks: shellRoles.map((role) => ({ role, name: (base.landmarks ?? []).find((l) => l.role === role)?.name ?? '' })),
    controls: base.controls.filter((x) => config.frameControls.some((re) => new RegExp(re).test(`${x.role}:${x.name}`))),
    headings: base.headings.filter((h) => config.frameHeadings.includes(h.text)),
  };
  return { scoped, notes: [...new Set(body)].map((role) => `body landmark, checked at full: ${role}`) };
}

// The structure of the gate itself: every name in routes.json is gated or exempt with a reason, every name a list refers to is a route, every reason is a sentence. Returns the problems (empty when sound).
export function gateProblems(routes, config) {
  const problems = [];
  const names = routes.map((r) => r.name);
  const known = new Set(names);
  const arrayOf = (what, v) => (Array.isArray(v) ? v : (problems.push(`approved-changes.json: ${what} must be an array`), []));
  const full = arrayOf('gates.full', config.gates?.full);
  const frame = arrayOf('gates.frame', config.gates?.frame);
  const pixelExact = arrayOf('gates.pixelExact', config.gates?.pixelExact);
  const lists = arrayOf('gates.lists', config.gates?.lists);
  const reasoned = (what, entries) => {
    const routesNamed = new Set();
    for (const e of arrayOf(what, entries)) {
      if (!known.has(e?.route)) problems.push(`${what}: ${JSON.stringify(e?.route)} is not a route in routes.json`);
      if (typeof e?.reason !== 'string' || e.reason.trim().length < MIN_REASON) problems.push(`${what}: ${e?.route} carries no reason (at least ${MIN_REASON} characters)`);
      routesNamed.add(e?.route);
    }
    return routesNamed;
  };
  const exempt = reasoned('exempt', config.exempt);
  const skippable = reasoned('skippable', config.skippable);
  const listEmpty = reasoned('listEmpty', config.listEmpty);
  const gated = new Set([...full, ...frame]);
  for (const n of names) {
    if (!gated.has(n) && !exempt.has(n)) problems.push(`route ${n} is in routes.json but is neither gated (gates.full, gates.frame) nor exempt with a reason`);
    if (gated.has(n) && exempt.has(n)) problems.push(`route ${n} is both gated and exempt`);
  }
  for (const n of full) if (frame.includes(n)) problems.push(`route ${n} is in both gates.full and gates.frame`);
  for (const n of gated) if (!known.has(n)) problems.push(`gates name ${n}, which routes.json does not`);
  for (const [what, list] of [['gates.pixelExact', pixelExact], ['gates.lists', lists]]) for (const n of list) if (!gated.has(n)) problems.push(`${what} names ${n}, which is not a gated route`);
  for (const n of skippable) if (!gated.has(n)) problems.push(`skippable names ${n}, which is not a gated route`);
  for (const n of listEmpty) if (!lists.includes(n)) problems.push(`listEmpty names ${n}, which is not in gates.lists`);
  return problems;
}

// A list route's baseline holds rows: a baseline with none compares nothing about its list, so it fails (unless listEmpty names the route with the reason its account has no rows).
export function emptyListProblem(route, baseRecord, config) {
  if (!(config.gates.lists ?? []).includes(route) || (config.listEmpty ?? []).some((e) => e.route === route)) return null;
  return (baseRecord.rows?.items ?? []).length === 0 ? 'baseline holds no list rows, so its list is not compared (recapture the baseline)' : null;
}

async function pixelLine({ stem, viewport, baseline, captured, diffDir, exact, approved }) {
  const pngA = `${baseline}/${stem}.png`;
  const a = await readFile(pngA).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (!a) return { lines: [], fail: false };
  const b = await readFile(`${captured}/${stem}.png`).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (!b) return { lines: [`${viewport}: capture image missing (${stem}.png)`], fail: exact };
  let d;
  try {
    d = pixelDiff(a, b);
  } catch (e) {
    return { lines: [`${viewport}: pixel compare error ${e.message}`], fail: exact };
  }
  const over = d.ratio > PIXEL_THRESHOLD;
  if (d.image) {
    await mkdir(diffDir, { recursive: true });
    await writeFile(`${diffDir}/${stem}.png`, d.image);
  }
  // A pixel waiver counts as used only when the diff is over the threshold on a gated route (the only case it changes the verdict).
  const pixelWaiver = approved.find((x) => x.kind === 'pixel' && (x.viewport === undefined || x.viewport === viewport));
  if (over && exact) hit(pixelWaiver);
  const tail = over && exact ? (pixelWaiver ? ' over, waived by an approved change' : ' GATE') : '';
  return { lines: [`${viewport}: pixel diff ${(d.ratio * 100).toFixed(2)}% (threshold ${PIXEL_THRESHOLD * 100}%)${tail}`], fail: over && exact && !pixelWaiver };
}

/** What a capture record says about itself, whatever the baseline holds: the offences its layout measure found, a page taller than the screenshot ceiling. */
export function intrinsicProblems(record) {
  const problems = [];
  if (!Array.isArray(record.offences)) problems.push('the record carries no `offences` list, so its layout was never measured');
  else for (const o of record.offences) problems.push(`offence: ${o}`);
  if (record.truncated === true) problems.push('the page is taller than the screenshot ceiling (truncated), so the lower part is not in the image');
  if (record.truncated === undefined) problems.push('the record does not say whether its screenshot was truncated');
  return problems;
}

/**
 * Runs the whole comparison. Returns `{ lines, failed, compared, gated }`; it prints nothing and exits nothing, so a test can plant any capture and read the verdict.
 * `signed_out_only` in the capture index is the one way a member route is not requested; a missing credential without it is a route that was not captured.
 */
export async function compareRun({ captured, baseline = 'tests/parity/baseline', config: configPath = 'tests/parity/approved-changes.json', routes: routesPath = 'tests/parity/routes.json', diffDir = DIFF_DIR }) {
  const config = await readJson(configPath);
  const routes = (await readJson(routesPath)).routes;
  const baseIndex = await readJson(`${baseline}/index.json`);
  const capIndex = await readJson(`${captured}/index.json`);
  const lines = [];
  let failed = false;
  const say = (line) => lines.push(line);
  for (const p of gateProblems(routes, config)) {
    failed = true;
    say(`FAIL      gate configuration: ${p}`);
  }
  const stale = baseIndex.contract !== CAPTURE_CONTRACT;
  if (stale) {
    failed = true;
    say(`FAIL      baseline: written under capture contract ${baseIndex.contract ?? 1}, this capture is contract ${CAPTURE_CONTRACT}; the baseline is recaptured (tests/parity/baseline/README.md) before anything is compared with it`);
  }
  if (capIndex.contract !== CAPTURE_CONTRACT) {
    failed = true;
    say(`FAIL      capture: written under capture contract ${capIndex.contract ?? 1}, the compare reads contract ${CAPTURE_CONTRACT}`);
  }
  const signedOut = capIndex.signed_out_only === true;
  const full = new Set(config.gates.full);
  const frame = new Set(config.gates.frame);
  const pixelExact = new Set(config.gates.pixelExact);
  const compared = new Set();
  let gated = 0;
  let skippedGated = 0;
  let notRequested = 0;
  for (const route of routes) {
    const isGated = full.has(route.name) || frame.has(route.name);
    const cap = capIndex.routes.find((r) => r.name === route.name);
    const entry = baseIndex.routes.find((r) => r.name === route.name);
    const skippable = (config.skippable ?? []).find((s) => s.route === route.name);
    const baseFiles = entry?.files ?? [];
    const result = (word, note, rest = []) => {
      say(`${word.padEnd(9)} ${route.name}${note ? `: ${note}` : ''}`);
      for (const l of rest) say(`            ${l}`);
    };
    if (isGated && signedOut && route.auth) {
      notRequested += 1;
      result('NOT ASKED', 'a signed-out run does not request a signed-in route');
      continue;
    }
    if (isGated) gated += 1;
    if (!cap || cap.status === 'skipped' || (cap.status === 'ok' && isGated && baseFiles.length === 0)) {
      if (!isGated) {
        result('SKIPPED', cap ? `${cap.error ?? 'skipped'}` : 'not captured (exempt route)');
      } else if (skippable) {
        skippedGated += 1;
        result('SKIPPED', cap?.status === 'ok' ? `${skippable.reason} (the capture succeeded: capture the baseline and delete this skippable entry)` : skippable.reason);
      } else {
        failed = true;
        result('FAIL', !cap ? 'gated route not captured' : cap.status === 'skipped' ? `capture skipped (${cap.error ?? 'no reason recorded'}) and approved-changes.json names no skippable reason for it` : `gated route has no baseline files and approved-changes.json names no skippable reason for it`);
      }
      continue;
    }
    if (cap.status !== 'ok') {
      failed ||= isGated;
      result(isGated ? 'FAIL' : 'ERROR', `capture ${cap.status}: ${cap.error}`);
      continue;
    }
    const approved = config.approved.filter((a) => a.route === route.name);
    const report = [];
    let routeFail = false;
    let relative = false;
    for (const stem of isGated ? baseFiles : cap.files) {
      const viewport = stem.split('.')[1];
      const c = await readOpt(`${captured}/${stem}.json`).catch((e) => ({ unreadable: e.message }));
      if (!c || c.unreadable) {
        report.push(`${viewport}: ${c ? `capture record unreadable (${c.unreadable})` : 'capture missing'}`);
        routeFail ||= isGated || Boolean(c);
        continue;
      }
      for (const p of intrinsicProblems(c)) {
        report.push(`${viewport}: ${p}`);
        routeFail = true;
      }
      if (!isGated || stale) continue;
      const b = await readOpt(`${baseline}/${stem}.json`).catch((e) => ({ unreadable: e.message }));
      if (!b || b.unreadable) {
        report.push(`${viewport}: baseline record ${b ? `unreadable (${b.unreadable})` : 'missing'} although the baseline index lists ${stem}`);
        routeFail = true;
        continue;
      }
      relative = true;
      const { scoped, notes } = frame.has(route.name) ? scopeFrame(b, config, viewport) : { scoped: b, notes: [] };
      for (const n of notes) report.push(`${viewport}: ${n}`);
      const empty = emptyListProblem(route.name, scoped, config);
      if (empty) {
        report.push(`${viewport}: ${empty}`);
        routeFail = true;
      }
      const { fails, used, until } = compareRecord(route.name, viewport, scoped, c, approved, config.dataNames ?? []);
      for (const f of fails) report.push(`${viewport}: ${f}`);
      if (used.length) report.push(`${viewport}: approved differences used: ${used.length}`);
      for (const m of [...new Set(until.map((u) => u.migration))]) report.push(`${viewport}: waived until migration ${m} is applied in production: ${until.filter((u) => u.migration === m).length}`);
      routeFail ||= fails.length > 0;
      const px = await pixelLine({ stem, viewport, baseline, captured, diffDir, exact: pixelExact.has(route.name), approved });
      report.push(...px.lines);
      routeFail ||= px.fail;
    }
    if (relative) compared.add(route.name);
    if (isGated && stale) {
      report.push('not compared: the baseline is stale');
      routeFail = true;
    }
    failed ||= routeFail;
    result(routeFail ? 'FAIL' : isGated ? 'PASS' : 'REPORTED', '', report);
  }
  const comparedGated = [...compared].filter((n) => full.has(n) || frame.has(n)).length;
  // Only routes this run compared count: a skipped route cannot show that its waivers are unused.
  const unused = config.approved.filter((a) => compared.has(a.route) && !USED_WAIVERS.has(a.id)).map((a) => a.id);
  if (comparedGated + skippedGated < gated) failed = true;
  say(`unused waivers: ${unused.length ? unused.join(', ') : 'none'}`);
  say(`compared ${comparedGated} of ${gated} gated routes${skippedGated ? `, ${skippedGated} named skippable with a reason` : ''}${notRequested ? `, ${notRequested} signed-in routes not requested (signed-out run)` : ''}`);
  say(failed ? 'parity: FAIL' : 'parity: ok');
  return { lines, failed, compared: comparedGated, gated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { lines, failed } = await compareRun(parseArgs(process.argv.slice(2)));
  for (const l of lines) console.log(l);
  process.exit(failed ? 1 : 0);
}
