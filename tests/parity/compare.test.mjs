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
