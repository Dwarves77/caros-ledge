// The parity compare can fail (G1, K:2 9 10 11 12 13): each planted fault below is a capture or a config the old compare passed, and the compare now turns red on it. The tests run the whole comparison over a
// throwaway world (tests/parity/world.mjs) and, for the exit code, the script itself. Nothing here needs a browser: images are read in Node (png.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { compareRun, gateProblems } from './compare.mjs';
import { listRow, record, solid, VIEWPORTS, world } from './world.mjs';

const ROUTES = [{ name: 'home' }, { name: 'regulations', auth: 'member' }];
const run = (w) => compareRun({ captured: w.captured, baseline: w.baseline, config: w.config, routes: w.routes, diffDir: w.diffDir });
const text = (r) => r.lines.join('\n');
const skippedEntries = (names, error = 'no member credentials') => names.map((name) => ({ name, path: `/${name}`, status: 'skipped', files: [], error }));
const okEntries = (names) => names.map((name) => ({ name, path: `/${name}`, status: 'ok', files: VIEWPORTS.map((v) => `${name}.${v}`), error: null }));

test('a clean capture is compared route by route and the report says how many: compared 2 of 2 gated routes', async () => {
  const r = await run(world({ routes: ROUTES }));
  assert.equal(r.failed, false, text(r));
  assert.match(text(r), /compared 2 of 2 gated routes/);
  assert.match(text(r), /parity: ok/);
});

test('R2 planted: a capture whose every route is skipped is red, however it came to be skipped (it used to end "parity: ok")', async () => {
  const w = world({ routes: ROUTES, capRoutes: skippedEntries(['home', 'regulations']) });
  const r = await run(w);
  assert.equal(r.failed, true);
  assert.match(text(r), /compared 0 of 2 gated routes/);
  assert.match(text(r), /capture skipped \(no member credentials\) and approved-changes.json names no skippable reason/);
  const cli = spawnSync(process.execPath, [resolve('tests/parity/compare.mjs'), '--captured', w.captured, '--baseline', w.baseline, '--config', w.config, '--routes', w.routes], { encoding: 'utf8' });
  assert.equal(cli.status, 1, 'the script exits 1');
  assert.match(cli.stdout, /parity: FAIL/);
});

test('a gated route missing from the capture is red; the same route named skippable with a reason is accounted for, and the report says so', async () => {
  const capRoutes = okEntries(['home']);
  assert.equal((await run(world({ routes: ROUTES, capRoutes }))).failed, true);
  const reason = 'baseline owed: the account holds no regulations yet, so there is nothing to capture';
  const w = world({ routes: ROUTES, capRoutes, config: { skippable: [{ route: 'regulations', reason }] } });
  const r = await run(w);
  assert.equal(r.failed, false, text(r));
  assert.match(text(r), /SKIPPED +regulations: baseline owed/);
  assert.match(text(r), /compared 1 of 2 gated routes, 1 named skippable with a reason/);
});

test('planted: a baseline with no files for a gated route is red, and a skippable reason is the only way past it', async () => {
  const baseRoutes = [...okEntries(['home']), { name: 'regulations', path: '/regulations', status: 'skipped', files: [], error: 'baseline owed' }];
  const r = await run(world({ routes: ROUTES, baseRoutes }));
  assert.equal(r.failed, true);
  assert.match(text(r), /FAIL +regulations: gated route has no baseline files/);
  const ok = await run(world({ routes: ROUTES, baseRoutes, config: { skippable: [{ route: 'regulations', reason: 'baseline owed: the account holds no regulations yet' }] } }));
  assert.equal(ok.failed, false, text(ok));
  assert.match(text(ok), /the capture succeeded: capture the baseline and delete this skippable entry/);
});

test('a signed-out run requests no signed-in route: those are NOT ASKED, counted apart, and the gated signed-out route is still compared', async () => {
  const r = await run(world({ routes: ROUTES, capRoutes: [...okEntries(['home']), ...skippedEntries(['regulations'])], capIndex: { signed_out_only: true } }));
  assert.equal(r.failed, false, text(r));
  assert.match(text(r), /NOT ASKED +regulations/);
  assert.match(text(r), /compared 1 of 1 gated routes, 1 signed-in routes not requested/);
});

test('planted: a route in routes.json that no gate names is red (gateProblems, and the run that reads it)', async () => {
  const w = world({ routes: [...ROUTES, { name: 'newpage' }], config: { gates: { full: ['home', 'regulations'] } } });
  const r = await run(w);
  assert.equal(r.failed, true);
  assert.match(text(r), /route newpage is in routes.json but is neither gated .* nor exempt with a reason/);
  const exempt = await run(world({ routes: [...ROUTES, { name: 'newpage' }], config: { gates: { full: ['home', 'regulations'] }, exempt: [{ route: 'newpage', reason: 'a page that holds no data of its own and is proven by its own smoke' }] } }));
  assert.equal(exempt.failed, false, text(exempt));
});

test('gateProblems: every kind of mistake in the gate configuration is named', () => {
  const routes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const good = { gates: { full: ['a'], frame: ['b'], pixelExact: ['a'], lists: ['a'] }, exempt: [{ route: 'c', reason: 'a long enough reason to stand' }], skippable: [], listEmpty: [] };
  assert.deepEqual(gateProblems(routes, good), []);
  const bad = (patch) => gateProblems(routes, { ...good, ...patch });
  assert.match(bad({ gates: { ...good.gates, full: ['a', 'ghost'] } }).join('|'), /gates name ghost/);
  assert.match(bad({ exempt: [{ route: 'c', reason: 'short' }] }).join('|'), /c carries no reason/);
  assert.match(bad({ exempt: [{ route: 'b', reason: 'a long enough reason to stand' }, ...good.exempt] }).join('|'), /route b is both gated and exempt/);
  assert.match(bad({ skippable: [{ route: 'c', reason: 'a long enough reason to stand' }] }).join('|'), /skippable names c, which is not a gated route/);
  assert.match(bad({ gates: { ...good.gates, lists: ['c'] } }).join('|'), /gates.lists names c/);
  assert.match(bad({ listEmpty: [{ route: 'b', reason: 'a long enough reason to stand' }] }).join('|'), /listEmpty names b, which is not in gates.lists/);
  assert.match(bad({ gates: { ...good.gates, full: ['a', 'b'] } }).join('|'), /both gates.full and gates.frame/);
  assert.match(bad({ exempt: undefined }).join('|'), /exempt must be an array/);
});

test('planted: a landmark renamed or swapped for another of the same role is red, and a missing one is told apart from a reordered one', async () => {
  const lm = (...pairs) => record({ landmarks: pairs.map(([role, name]) => ({ role, name })) });
  const base = lm(['navigation', 'Main'], ['region', 'Filters'], ['region', 'Results']);
  const check = async (cap) => {
    const r = await run(world({ routes: [{ name: 'home' }], base, cap }));
    return { failed: r.failed, text: text(r) };
  };
  assert.equal((await check(base)).failed, false);
  const renamed = await check(lm(['navigation', 'Main'], ['region', 'Filters'], ['region', 'Results (all)']));
  assert.equal(renamed.failed, true);
  assert.match(renamed.text, /landmark missing: region:Results/);
  const swapped = await check(lm(['navigation', 'Main'], ['region', 'Results'], ['region', 'Filters']));
  assert.match(swapped.text, /landmark reordered: region:Results/);
  const dropped = await check(lm(['navigation', 'Main'], ['region', 'Results']));
  assert.match(dropped.text, /landmark missing: region:Filters/);
  assert.doesNotMatch(dropped.text, /landmark reordered/);
});

test('a pixel diff over the threshold on a pixelExact route is red; an unreadable, truncated or missing image on that route is red too (it used to print a line and pass)', async () => {
  const config = { gates: { pixelExact: ['home'] } };
  const withImages = (capture) => {
    const w = world({ routes: [{ name: 'home' }], config });
    for (const v of VIEWPORTS) {
      writeFileSync(join(w.baseline, `home.${v}.png`), solid(40, 30, [250, 250, 250]));
      if (capture) writeFileSync(join(w.captured, `home.${v}.png`), capture);
    }
    return w;
  };
  assert.equal((await run(withImages(solid(40, 30, [250, 250, 250])))).failed, false, 'identical images pass');
  const different = await run(withImages(solid(40, 30, [0, 0, 0])));
  assert.equal(different.failed, true);
  assert.match(text(different), /pixel diff 100.00% .* GATE/);
  const good = solid(40, 30, [250, 250, 250]);
  const garbage = await run(withImages(Buffer.from('this is not a png at all, only text')));
  assert.equal(garbage.failed, true);
  assert.match(text(garbage), /pixel compare error not a PNG/);
  const truncated = await run(withImages(good.subarray(0, good.length - 20)));
  assert.equal(truncated.failed, true);
  assert.match(text(truncated), /pixel compare error/);
  const flipped = Buffer.from(good);
  flipped[40] ^= 0xff;
  assert.match(text(await run(withImages(flipped))), /pixel compare error PNG .* fails its CRC|pixel compare error/);
  const missing = await run(withImages(null));
  assert.equal(missing.failed, true);
  assert.match(text(missing), /capture image missing/);
});

test('a pixel waiver covers the diff it names and nothing else', async () => {
  const config = { gates: { pixelExact: ['home'] }, approved: [{ id: 'look-1', route: 'home', kind: 'pixel', ruling: 'a look ruling' }] };
  const w = world({ routes: [{ name: 'home' }], config });
  for (const v of VIEWPORTS) {
    writeFileSync(join(w.baseline, `home.${v}.png`), solid(40, 30, [250, 250, 250]));
    writeFileSync(join(w.captured, `home.${v}.png`), solid(40, 30, [0, 0, 0]));
  }
  const r = await run(w);
  assert.equal(r.failed, false, text(r));
  assert.match(text(r), /over, waived by an approved change/);
});

test('the layout offences a capture carries fail its route, wherever the baseline agrees; a record that never measured its layout, or says nothing of truncation, fails too', async () => {
  const offending = await run(world({ routes: [{ name: 'home' }], cap: { offences: ['target under 24 px: button.cl-x "Go" 20x20'] } }));
  assert.equal(offending.failed, true);
  assert.match(text(offending), /1280x900: offence: target under 24 px/);
  const never = await run(world({ routes: [{ name: 'home' }], cap: { offences: undefined } }));
  assert.match(text(never), /carries no `offences` list/);
  const truncated = await run(world({ routes: [{ name: 'home' }], cap: { truncated: true } }));
  assert.equal(truncated.failed, true);
  assert.match(text(truncated), /taller than the screenshot ceiling/);
  assert.match(text(await run(world({ routes: [{ name: 'home' }], cap: { truncated: undefined } }))), /does not say whether its screenshot was truncated/);
});

test('an exempt route that is captured still has its offences checked (the admin console on the deployed preview)', async () => {
  const config = { gates: { full: ['home'] }, exempt: [{ route: 'admin', reason: 'no baseline exists: the console is account data, held by its own smoke' }] };
  const w = world({ routes: [{ name: 'home' }, { name: 'admin', auth: 'admin' }], config, cap: { offences: ['overflow: div.cl-x right 1400 > 1280'] }, baseRoutes: okEntries(['home']) });
  const r = await run(w);
  assert.match(text(r), /FAIL\s+home/);
  assert.match(text(r), /REPORTED|FAIL\s+admin/);
  const clean = await run(world({ routes: [{ name: 'home' }, { name: 'admin', auth: 'admin' }], config, baseRoutes: okEntries(['home']) }));
  assert.equal(clean.failed, false, text(clean));
});

test('lists: a list route whose baseline holds no rows is red; listEmpty with a reason is the only way past; a missing container or a reordered row is red', async () => {
  const rows = (...texts) => record({ rows: { selector: '', items: texts.map((t) => listRow(t)), containers: [{ label: 'Results', count: texts.length }] } });
  const cfg = { gates: { lists: ['home'] } };
  const empty = await run(world({ routes: [{ name: 'home' }], config: cfg }));
  assert.equal(empty.failed, true);
  assert.match(text(empty), /baseline holds no list rows/);
  const allowed = await run(world({ routes: [{ name: 'home' }], config: { ...cfg, listEmpty: [{ route: 'home', reason: 'the baseline account follows nothing at all' }] } }));
  assert.equal(allowed.failed, false, text(allowed));
  const base = rows('EU Fuel rule', 'UK Carbon tax', 'US Port charge');
  assert.equal((await run(world({ routes: [{ name: 'home' }], config: cfg, base, cap: base }))).failed, false);
  const swapped = await run(world({ routes: [{ name: 'home' }], config: cfg, base, cap: rows('EU Fuel rule', 'US Port charge', 'UK Carbon tax') }));
  assert.equal(swapped.failed, true);
  assert.match(text(swapped), /row reordered: div:US Port charge/);
  const lost = await run(world({ routes: [{ name: 'home' }], config: cfg, base, cap: record() }));
  assert.match(text(lost), /list container missing: Results/);
  assert.match(text(lost), /row missing: div:EU Fuel rule/);
  const grown = rows('EU Fuel rule', 'NEW Sea rule', 'UK Carbon tax', 'US Port charge');
  assert.equal((await run(world({ routes: [{ name: 'home' }], config: cfg, base, cap: grown }))).failed, false, 'new rows between the baseline rows are data, not a difference');
});

test('a baseline written under another capture contract is not compared: one line names the recapture, and nothing is reported as passing', async () => {
  const w = world({ routes: ROUTES, baseIndex: { contract: 1 } });
  const r = await run(w);
  assert.equal(r.failed, true);
  assert.match(text(r), /baseline: written under capture contract 1, this capture is contract 2/);
  assert.match(text(r), /compared 0 of 2 gated routes/);
  assert.doesNotMatch(text(r), /PASS/);
  const old = await run(world({ routes: ROUTES, capIndex: { contract: undefined } }));
  assert.match(text(old), /capture: written under capture contract 1/);
});

test('a corrupt capture record is a failure the report names, not a crash', async () => {
  const w = world({ routes: [{ name: 'home' }] });
  writeFileSync(join(w.captured, 'home.1280x900.json'), '{ not json');
  const r = await run(w);
  assert.equal(r.failed, true);
  assert.match(text(r), /capture record unreadable/);
});

test('the committed configuration is sound: every route in routes.json is gated or exempt with a reason', () => {
  const routes = JSON.parse(readFileSync('tests/parity/routes.json', 'utf8')).routes;
  const config = JSON.parse(readFileSync('tests/parity/approved-changes.json', 'utf8'));
  assert.deepEqual(gateProblems(routes, config), []);
});
