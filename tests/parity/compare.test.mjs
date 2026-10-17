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
