import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compareRecord, scopeFrame } from './compare.mjs';

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
