import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compareRecord, scopeFrame } from './compare.mjs';

const config = JSON.parse(await readFile(new URL('./approved-changes.json', import.meta.url), 'utf8'));
const base = { landmarks: [{ role: 'complementary' }, { role: 'navigation' }, { role: 'banner' }, { role: 'search' }, { role: 'main' }], controls: [], headings: [], rows: { items: [] } };
const capture = (roles) => ({ landmarks: roles.map((role) => ({ role })), controls: [], headings: [], rows: { items: [] } });
const frameCompare = (roles) => {
  const { scoped, notes } = scopeFrame(base, config, '1280x900');
  return { ...compareRecord('regulations', '1280x900', scoped, capture(roles), []), notes };
};

test('a frame record missing a shell landmark fails', () => {
  const { fails } = frameCompare(['complementary', 'main']);
  assert.deepEqual(fails, ['landmark missing: navigation']);
});

test('a frame record missing a body landmark passes, with the body note', () => {
  const { fails, notes } = frameCompare(['complementary', 'navigation', 'main']);
  assert.deepEqual(fails, []);
  assert.deepEqual(notes, ['body landmark, checked at full: banner', 'body landmark, checked at full: search']);
});

test('a full route still fails on a missing body landmark', () => {
  assert.deepEqual(compareRecord('home', '1280x900', base, capture(['complementary', 'navigation', 'main']), []).fails, ['landmark missing: banner', 'landmark missing: search']);
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
