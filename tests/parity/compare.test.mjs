import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compareRecord, gateProblems, scopeFrame } from './compare.mjs';

const config = JSON.parse(await readFile(new URL('./approved-changes.json', import.meta.url), 'utf8'));
const NAMES = { complementary: 'Side', navigation: 'Platform', banner: '', search: 'Search the ledger', main: '' };
const base = { landmarks: Object.entries(NAMES).map(([role, name]) => ({ role, name })), controls: [], headings: [], rows: { items: [] } };
const capture = (roles) => ({ landmarks: roles.map((role) => ({ role, name: NAMES[role] })), controls: [], headings: [], rows: { items: [] } });
const frameCompare = (roles) => {
  const { scoped, notes } = scopeFrame(base, config, '1280x900');
  return { ...compareRecord('regulations', '1280x900', scoped, capture(roles), []), notes };
};

test('a frame record missing a shell landmark fails', () => {
  const { fails } = frameCompare(['complementary', 'main']);
  assert.deepEqual(fails, ['landmark missing: navigation:Platform']);
});

test('a frame record missing a body landmark passes, with the body note', () => {
  const { fails, notes } = frameCompare(['complementary', 'navigation', 'main']);
  assert.deepEqual(fails, []);
  assert.deepEqual(notes, ['body landmark, checked at full: banner', 'body landmark, checked at full: search']);
});

test('a full route still fails on a missing body landmark', () => {
  assert.deepEqual(compareRecord('home', '1280x900', base, capture(['complementary', 'navigation', 'main']), []).fails, ['landmark missing: banner:', 'landmark missing: search:Search the ledger']);
});

test('counts are data: a count change passes, a rename or a removal fails', () => {
  const b = { landmarks: [], headings: [{ level: 2, text: 'GLOBAL18' }], controls: [{ role: 'button', name: '+ 18 more' }, { role: 'button', name: '13 hidden by your scope · Show all' }], rows: { items: [] } };
  const withControls = (controls, text) => ({ landmarks: [], headings: [{ level: 2, text }], controls, rows: { items: [] } });
  const same = [{ role: 'button', name: '+ 7 more' }, { role: 'button', name: '53 hidden by your scope · Show all' }];
  assert.deepEqual(compareRecord('market', '1280x900', b, withControls(same, 'GLOBAL16'), []).fails, []);
  const renamed = [{ role: 'button', name: '+ 7 less' }, same[1]];
  assert.deepEqual(compareRecord('market', '1280x900', b, withControls(renamed, 'GLOBAL16'), []).fails, ['control missing: button:+ # more']);
  assert.deepEqual(compareRecord('market', '1280x900', b, withControls([same[0]], 'GLOBAL16'), []).fails, ['control missing: button:# hidden by your scope · Show all']);
});

test('a row key carries live counts as data: a count change passes, a renamed row fails', () => {
  const rows = (text) => ({ landmarks: [], headings: [], controls: [], rows: { items: [{ tag: 'li', text, width: 300, height: 40 }] } });
  const base = rows('Operations matrix 2/7 sourced · 985 regs');
  assert.deepEqual(compareRecord('operations', '1280x900', base, rows('Operations matrix 3/7 sourced · 991 regs'), []).fails, []);
  assert.equal(compareRecord('operations', '1280x900', base, rows('Operations grid 2/7 sourced · 985 regs'), []).fails.length, 1);
});

test('the account name token (from LIVE_SMOKE_EMAIL) matches the baseline smoke; a different name still fails', () => {
  const was = process.env.LIVE_SMOKE_EMAIL;
  process.env.LIVE_SMOKE_EMAIL = 'testperson@example.invalid';
  try {
    const heading = (text) => ({ landmarks: [], controls: [], rows: { items: [] }, headings: [{ level: 2, text }] });
    const base = heading("SMOKE'S BRIEF");
    assert.deepEqual(compareRecord('dashboard', '1280x900', base, heading("TESTPERSON'S BRIEF"), []).fails, []);
    assert.deepEqual(compareRecord('dashboard', '1280x900', heading("smoke'S BRIEF"), heading("TestPerson'S BRIEF"), []).fails, []);
    assert.equal(compareRecord('dashboard', '1280x900', base, heading("OTHERNAME'S BRIEF"), []).fails.length, 1);
  } finally {
    if (was === undefined) delete process.env.LIVE_SMOKE_EMAIL;
    else process.env.LIVE_SMOKE_EMAIL = was;
  }
});

test('an order waiver covers a reordered control and nothing else: a missing or renamed control under the same pattern still fails, and another route is not covered', () => {
  const link = (name) => ({ role: 'link', name });
  const ctl = (controls) => ({ landmarks: [], headings: [], controls, rows: { items: [] } });
  const b = ctl([link('Compliance deadline A'), link('Compliance deadline B'), link('Other')]);
  const waiver = [{ id: 'tie-order', route: 'market', kind: 'order', match: '^link:Compliance deadline', ruling: 'planted' }];
  const swapped = ctl([link('Compliance deadline B'), link('Compliance deadline A'), link('Other')]);
  assert.deepEqual(compareRecord('market', '1280x900', b, swapped, []).fails, ['control reordered: link:Compliance deadline B']);
  const waived = compareRecord('market', '1280x900', b, swapped, waiver);
  assert.deepEqual(waived.fails, []);
  assert.deepEqual(waived.used, ['control reordered: link:Compliance deadline B']);
  assert.deepEqual(compareRecord('regulations', '1280x900', b, swapped, waiver).fails, ['control reordered: link:Compliance deadline B'], 'the waiver is per route');
  assert.deepEqual(compareRecord('market', '1280x900', b, ctl([link('Compliance deadline B'), link('Other')]), waiver).fails, ['control missing: link:Compliance deadline A'], 'a missing control still fails');
  assert.deepEqual(compareRecord('market', '1280x900', b, ctl([link('Compliance deadline A'), link('Compliance deadline Z'), link('Other')]), waiver).fails, ['control missing: link:Compliance deadline B'], 'a renamed control still fails');
  assert.deepEqual(compareRecord('market', '1280x900', ctl([link('Compliance deadline A'), link('Other')]), ctl([link('Other'), link('Compliance deadline A')]), waiver).fails, ['control reordered: link:Other'], 'a control outside the pattern is still held to its order');
});

test('dataNames: a control named by live data compares by its stable prefix on both sides, and nothing else is loosened', () => {
  const dataNames = [{ route: 'community', match: '^(Global|EU) room', keep: '^(Global|EU) room', reason: 'tiles are named by live data' }];
  const ctl = (...names) => ({ landmarks: [], headings: [], rows: { items: [] }, controls: names.map((name) => ({ role: 'button', name })) });
  const base = ctl('Global room9Research · Fuels · Corridorsno discussions yet', 'EU room733Emissions · Reportingno discussions yet', 'Post');
  const live = ctl('Global room54Research · Fuels · Emissionsno discussions yet', 'EU room1,000Transport · Maritimeno discussions yet', 'Post');
  assert.deepEqual(compareRecord('community', '1280x900', base, live, [], dataNames).fails, []);
  assert.equal(compareRecord('community', '1280x900', base, live, [], []).fails.length, 2, 'without the entry the live words fail');
  assert.deepEqual(compareRecord('community', '1280x900', base, ctl('EU room1Emissions', 'Global room2Fuels', 'Post'), [], dataNames).fails.length, 1, 'order still gates');
  assert.deepEqual(compareRecord('community', '1280x900', base, ctl('Global room54x', 'Post'), [], dataNames).fails, ['control missing: button:EU room'], 'a missing tile still fails');
  assert.deepEqual(compareRecord('community', '1280x900', base, ctl('Global room54x', 'EU room1y'), [], dataNames).fails, ['control missing: button:Post'], 'other controls are exact');
  assert.equal(compareRecord('community', '1280x900', base, live, [], dataNames).used.some((u) => u.startsWith('data names:')), true, 'the reason is recorded');
});

// Rule, not literal: the baseline is the new production site, so every waiver in the file must match a current difference (the unused-waivers line of compare.mjs), and every gated route must have baseline files.
test('every gated full route has baseline files, and every standing waiver names a gated route and carries a ruling', async () => {
  const index = JSON.parse(await readFile(new URL('./baseline/index.json', import.meta.url), 'utf8'));
  for (const name of [...config.gates.full, ...config.gates.frame]) {
    const r = index.routes.find((x) => x.name === name);
    assert.ok(r, `gated route ${name} is in the baseline index`);
    if (r.status === 'skipped') continue; // community-group: baseline owed, reported not failed
    for (const stem of r.files) await readFile(new URL(`./baseline/${stem}.json`, import.meta.url), 'utf8');
  }
  for (const w of config.approved) {
    assert.ok(w.ruling, `waiver ${w.id} carries its ruling`);
    assert.ok([...config.gates.full, ...config.gates.frame].includes(w.route), `waiver ${w.id} names a gated route`);
  }
});

test('one waiver may name several kinds: it covers a missing control and a missing row it matches, and nothing it does not match', () => {
  const rec = (controls, rows) => ({ landmarks: [], headings: [], controls, rows: { items: rows.map((text) => ({ tag: 'div', text, width: 300, height: 40 })) } });
  const b = rec([{ role: 'button', name: 'Awareness - background, 2 items' }, { role: 'button', name: 'Other' }], ['Row one NEEDS MORE DATA']);
  const waiver = [{ id: 'both', route: 'regulations', kind: ['control', 'row'], match: '^(button:Awareness |div:Row one)', ruling: 'planted' }];
  assert.deepEqual(compareRecord('regulations', '1280x900', b, rec([{ role: 'button', name: 'Other' }], ['Row one needs more data']), waiver).fails, []);
  assert.deepEqual(compareRecord('regulations', '1280x900', b, rec([], ['Row one needs more data']), waiver).fails, ['control missing: button:Other']);
  assert.equal(compareRecord('market', '1280x900', b, rec([{ role: 'button', name: 'Other' }], []), waiver).fails.length, 2, 'another route is not covered');
});

test('D4: items A to E against F to J in the same slots passes; an Action band with no items fails; a changed masthead fails', () => {
  const bandPage = (masthead, actionItems, monitorItems, marked = true) => ({
    landmarks: [{ role: 'main', name: '' }],
    headings: [
      { level: 1, text: masthead },
      ...actionItems.map((t) => ({ level: 3, text: t, ...(marked ? { item: true } : {}) })),
      ...monitorItems.map((t) => ({ level: 3, text: t, ...(marked ? { item: true } : {}) })),
    ],
    controls: [
      { role: 'button', name: 'Export ledger' },
      ...actionItems.flatMap((t) => [
        { role: 'link', name: t, ...(marked ? { item: true } : {}) },
        { role: 'button', name: 'Watch', ...(marked ? { item: true } : {}) },
      ]),
      { role: 'button', name: 'All 12 action →' },
      ...monitorItems.flatMap((t) => [
        { role: 'link', name: t, ...(marked ? { item: true } : {}) },
        { role: 'button', name: 'Watch', ...(marked ? { item: true } : {}) },
      ]),
      { role: 'button', name: 'All 16 monitor →' },
    ],
    rows: {
      containers: [
        ...(actionItems.length ? [{ label: 'Action', count: actionItems.length }] : []),
        ...(monitorItems.length ? [{ label: 'Monitor', count: monitorItems.length }] : []),
      ],
      items: [
        ...actionItems.map((t) => ({ tag: 'div', text: `${t} · Tier 1 · due in 30d`, width: 800, height: 52, container: 'Action', ...(marked ? { item: true } : {}) })),
        ...monitorItems.map((t) => ({ tag: 'div', text: `${t} · Tier 2 · due in 90d`, width: 800, height: 52, container: 'Monitor', ...(marked ? { item: true } : {}) })),
      ],
    },
  });

  const base = bandPage('Regulations ledger', ['Item A', 'Item B', 'Item C'], ['Item D', 'Item E'], false);
  const moved = bandPage('Regulations ledger', ['Item F', 'Item G', 'Item H'], ['Item I', 'Item J'], true);
  // Red-first: without item marks (pre-D4), the moved corpus fails on every item heading, link and row.
  assert.equal(compareRecord('regulations', '1280x900', base, bandPage('Regulations ledger', ['Item F', 'Item G', 'Item H'], ['Item I', 'Item J'], false), []).fails.length > 0, true);
  // 1. Items A to E against F to J in the same slots passes.
  const ok = compareRecord('regulations', '1280x900', base, moved, []);
  assert.deepEqual(ok.fails, []);
  assert.equal(ok.shaped > 0, true);
  // 2. An Action band with no items fails.
  const emptyAction = bandPage('Regulations ledger', [], ['Item F', 'Item G', 'Item H', 'Item I', 'Item J'], true);
  const emptyFails = compareRecord('regulations', '1280x900', base, emptyAction, []).fails;
  assert.equal(emptyFails.some((f) => f.includes('item section empty') && f.includes('All # action →')), true);
  // 3. A changed masthead fails.
  const badMasthead = bandPage('Wrong masthead title', ['Item F', 'Item G', 'Item H'], ['Item I', 'Item J'], true);
  assert.deepEqual(compareRecord('regulations', '1280x900', base, badMasthead, []).fails, ['heading missing: 1:Regulations ledger']);

});

// PARITY-3 (main run 40202525249): a panel's absence-state action ("Request coverage") exists only while the panel has no data. ARM-1 filled grid_connection_queues, the grid panel drew rows, one of the two baseline buttons
// went, and the gate failed on data. `conditional` entries ({route, match, reason}) are compared when present on both sides and ignored when absent on either; nothing else is loosened.
test('conditional: a data-conditional control is compared when present on both sides and ignored when absent on either', async () => {
  const conditional = [{ route: 'operations-detail', match: '^button:Request coverage$', reason: 'absence-state action of a panel' }];
  const ctl = (...names) => ({ landmarks: [], headings: [], rows: { items: [] }, controls: names.map((name) => ({ role: name.startsWith('Back') ? 'link' : 'button', name })) });
  const RC = 'Request coverage';
  const b = ctl('S3', RC, RC, 'Back to list', 'Add note');
  const run = (cap, entries = conditional, route = 'operations-detail') => compareRecord(route, '1280x900', b, cap, [], [], entries);
  assert.deepEqual(run(ctl('S3', RC, 'Back to list', 'Add note'), []).fails, ['control reordered: button:Request coverage'], 'without the entry the CI failure reproduces');
  assert.deepEqual(run(ctl('S3', RC, 'Back to list', 'Add note')).fails, [], 'one panel filled: one button left');
  assert.deepEqual(run(ctl('S3', 'Back to list', 'Add note')).fails, [], 'both panels filled: none left');
  assert.deepEqual(run(ctl('S3', RC, RC, RC, 'Back to list', 'Add note')).fails, [], 'a panel emptied: more than the baseline');
  assert.equal(run(ctl('S3', RC, 'Back to list', 'Add note')).used.some((u) => u.startsWith('conditional:')), true, 'the reason is recorded');
  assert.deepEqual(run(ctl('S3', RC, 'Back to list', 'Add note'), conditional, 'market').fails.length, 1, 'per route');
  assert.deepEqual(run(ctl('S3', RC, 'Add note', 'Back to list')).fails, ['control reordered: button:Add note'], 'other controls still gate order');
  assert.deepEqual(run(ctl('S3', RC, 'Back to list')).fails, ['control missing: button:Add note'], 'other controls still gate presence');
  assert.deepEqual(run(ctl(RC, 'S3', 'Back to list', 'Add note')).fails, ['control reordered: button:Request coverage'], 'a present conditional control is held to its place');
  const real = JSON.parse(await readFile(new URL('./baseline/operations-detail.1280x900.json', import.meta.url), 'utf8'));
  const keep = real.controls.filter((c, i) => i !== 61);
  assert.equal(real.controls.filter((c) => c.name === RC).length, 2, 'the baseline holds the two buttons');
  assert.deepEqual(compareRecord('operations-detail', '1280x900', real, { ...real, controls: keep }, [], config.dataNames ?? [], config.conditional ?? []).fails, [], 'the committed config covers the production case');
  assert.equal(compareRecord('operations-detail', '1280x900', real, { ...real, controls: real.controls.filter((c, i) => i !== 14) }, [], config.dataNames ?? [], config.conditional ?? []).fails.length, 1, 'a removed ordinary control fails under the committed config');
});

// PARITY-4 (main run 40222359593): the ruled runs wrote production while the parity job read it. Market lost two of its three absence-state buttons (oem_tech_roadmaps and reroute_events filled), and market-detail lost the
// theme brief's own headings (the 18:43 theme recompute put the baseline item into a theme with no brief). Both are data the baseline predates; the committed config must cover them and nothing else.
test('conditional: the production case of main run 40222359593 passes under the committed config, and a changed neighbour still fails', async () => {
  const read = async (name) => JSON.parse(await readFile(new URL(`./baseline/${name}.1280x900.json`, import.meta.url), 'utf8'));
  const run = (route, b, c) => compareRecord(route, '1280x900', b, c, [], config.dataNames ?? [], config.conditional ?? []).fails;
  const market = await read('market');
  const rc = market.controls.map((c, i) => (c.name === 'Request coverage' ? i : -1)).filter((i) => i >= 0);
  assert.equal(rc.length, 3, 'the baseline holds the three buttons');
  assert.deepEqual(run('market', market, { ...market, controls: market.controls.filter((c, i) => i !== rc[0] && i !== rc[1]) }), [], 'two panels filled');
  assert.deepEqual(run('market', market, { ...market, controls: market.controls.filter((c, i) => !rc.includes(i)) }), [], 'all three filled');
  assert.equal(run('market', market, { ...market, controls: market.controls.filter((c) => c.name !== 'Back to top') }).length, 1, 'an ordinary control still fails');

  const detail = await read('market-detail');
  const at = detail.headings.findIndex((h) => h.text === 'Connected intelligence');
  const brief = detail.headings.filter((h, i) => i > at && h.level === 4 && i < detail.headings.findIndex((x, j) => j > at && x.level === 2 && x.text === 'Notes'));
  assert.equal(brief.length, 5, 'the baseline draws the theme brief headings');
  const without = detail.headings.filter((h) => !brief.includes(h));
  assert.deepEqual(run('market-detail', detail, { ...detail, headings: without }), [], 'no theme brief: its headings are not owed');
  assert.deepEqual(run('market-detail', detail, detail), [], 'a theme brief drawn as before');
  assert.equal(run('market-detail', detail, { ...detail, headings: without.filter((h) => h.text !== 'Connected intelligence') }).length, 1, 'the section heading itself is still owed');
  assert.equal(run('market-detail', detail, { ...detail, headings: without.filter((h) => h.text !== 'Sources') }).length, 1, 'a heading outside the section is still owed');
  const drawnBackwards = [...without.slice(0, at + 1), ...brief.slice().reverse(), ...without.slice(at + 1)];
  assert.ok(run('market-detail', detail, { ...detail, headings: drawnBackwards }).length > 0, 'a drawn brief is held to its order');
  assert.equal(run('market', detail, { ...detail, headings: without }).length, 5, 'per route');
});

test('gateProblems: a conditional entry names real routes, a reason, a match, and for a heading the heading it sits under', () => {
  const routes = [{ name: 'a' }, { name: 'b' }];
  const good = { gates: { full: ['a', 'b'], frame: [], pixelExact: [], lists: [] }, exempt: [], skippable: [], listEmpty: [], conditional: [{ route: ['a', 'b'], kind: 'heading', under: '2:X', match: '^4:', reason: 'a long enough reason to stand' }, { route: 'a', match: '^button:Y$', reason: 'a long enough reason to stand' }] };
  assert.deepEqual(gateProblems(routes, good), []);
  const bad = (entry) => gateProblems(routes, { ...good, conditional: [entry] }).join('|');
  assert.match(bad({ ...good.conditional[0], route: ['a', 'ghost'] }), /"ghost" is not a route/);
  assert.match(bad({ ...good.conditional[0], reason: 'short' }), /carries no reason/);
  assert.match(bad({ ...good.conditional[0], under: undefined }), /needs a match and an under heading/);
  assert.match(bad({ ...good.conditional[1], match: undefined }), /needs a match/);
});

// PARITY-5 (main run 40286264250): the baseline was captured while the live-smoke account had no profile name, so the Assign to chips read "— Name not set"; the operator named the profile "Jason" on 2026-10-26.
// The member's name is data. The run of chips between Add note and Due date compares as one token; the chips must still be drawn and nothing else loosens.
test('dataNames run: the member chips compare as one token, a missing run still fails, a changed neighbour still fails', async () => {
  const detailRoutes = ['regulation-detail', 'market-detail', 'research-detail', 'operations-detail'];
  const run = (route, b, c) => compareRecord(route, '1280x900', b, c, [], config.dataNames ?? [], config.conditional ?? []);
  const ctl = (...names) => ({ controls: names.map((n) => ({ role: n.startsWith('Due date') ? 'textbox' : 'button', name: n })) });
  const base = ctl('Add note', 'Jason', '— Name not set', 'Due date (optional)', 'Assign');
  const named = ctl('Add note', 'Jason', 'Jason', 'Due date (optional)', 'Assign');
  for (const route of detailRoutes) {
    assert.deepEqual(run(route, base, named).fails, [], `${route}: an absent name against a set one`);
    assert.deepEqual(run(route, base, ctl('Add note', 'Dana Whitfield', 'Due date (optional)', 'Assign')).fails, [], `${route}: any name, any roster size`);
    assert.deepEqual(run(route, named, base).fails, [], `${route}: and the other way`);
  }
  assert.equal(run('market-detail', base, named).used.some((u) => u.startsWith('data names:')), true, 'the reason is recorded');
  assert.deepEqual(run('market-detail', base, ctl('Add note', 'Due date (optional)', 'Assign')).fails, ['control missing: button:member name'], 'the button absent still fails');
  assert.deepEqual(run('market-detail', base, ctl('Add note', 'Jason', 'Due date (optional)')).fails, ['control missing: button:Assign'], 'a different control missing still fails');
  assert.deepEqual(run('market-detail', base, ctl('Add note', 'Jason', 'Due date (optional)', 'Assign now')).fails, ['control missing: button:Assign'], 'a different control renamed still fails');
  assert.deepEqual(run('market-detail', base, ctl('Add note', 'Jason', 'Other control', 'Due date (optional)', 'Assign')).fails.length, 0, 'extra buttons in the span are chips: the roster is data');
  assert.deepEqual(run('market-detail', ctl('Add note', 'Export', 'Due date (optional)'), ctl('Add note', 'Due date (optional)')).fails, ['control missing: button:member name'], 'a baseline run is owed whatever it held');
  assert.equal(run('market', base, ctl('Add note', 'Jason', 'Jason', 'Due date (optional)', 'Assign')).fails.length, 1, 'per route: elsewhere the name still gates');
  const real = JSON.parse(await readFile(new URL('./baseline/market-detail.1280x900.json', import.meta.url), 'utf8'));
  assert.deepEqual(run('market-detail', real, { ...real, controls: real.controls.map((c) => (c.name === '— Name not set' ? { ...c, name: 'Jason' } : c)) }).fails, [], 'the production case under the committed config');
  assert.equal(run('market-detail', real, { ...real, controls: real.controls.filter((c) => c.name !== '— Name not set' && c.name !== 'Jason') }).fails.length, 1, 'the committed baseline owes the run');
  assert.equal(run('market-detail', real, { ...real, controls: real.controls.map((c) => (c.name === 'Add note' ? { ...c, name: 'Add a note' } : c)) }).fails.length > 0, true, 'a different control changed still fails under the committed config');
});

test('gateProblems: a run entry names real routes, a reason, both anchors and a token', () => {
  const routes = [{ name: 'a' }];
  const good = { gates: { full: ['a'], frame: [], pixelExact: [], lists: [] }, exempt: [], skippable: [], listEmpty: [], dataNames: [{ route: ['a'], kind: 'run', after: '^button:A$', before: '^button:B$', as: 'member name', reason: 'a long enough reason to stand' }] };
  assert.deepEqual(gateProblems(routes, good), []);
  const bad = (over) => gateProblems(routes, { ...good, dataNames: [{ ...good.dataNames[0], ...over }] }).join('|');
  assert.match(bad({ route: ['ghost'] }), /"ghost" is not a route/);
  assert.match(bad({ reason: 'short' }), /carries no reason/);
  assert.match(bad({ as: undefined }), /needs after, before and as/);
  assert.match(bad({ before: undefined }), /needs after, before and as/);
});
