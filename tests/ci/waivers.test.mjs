// The until-migration parity waiver: it covers a difference while the migration is absent from production, and it fails the tree-check once supabase/migrations/APPLIED.json lists the migration.
import assert from 'node:assert/strict';
import test from 'node:test';

import { appliedMigrations, retiredWaiverProblems } from '../../scripts/ci/waiver-check.mjs';
import { compareRecord } from '../parity/compare.mjs';

const waiver = { id: 'w1', route: 'regulation-detail', kind: 'until-migration', migration: '0031', on: 'heading', match: '^2:Obligations$' };
const base = { landmarks: [], headings: [{ level: 2, text: 'Obligations' }], controls: [], rows: { items: [] } };
const cap = { landmarks: [], headings: [], controls: [], rows: { items: [] } };

test('while the migration is absent the waiver covers its difference and is counted apart; an unlisted difference still fails', () => {
  const r = compareRecord('regulation-detail', '1280x900', base, cap, [waiver]);
  assert.deepEqual(r.fails, []);
  assert.deepEqual(r.used, []);
  assert.deepEqual(r.until, [{ line: 'heading missing: 2:Obligations', migration: '0031' }]);
  assert.deepEqual(compareRecord('regulation-detail', '1280x900', base, cap, []).fails, ['heading missing: 2:Obligations']);
  assert.deepEqual(compareRecord('regulation-detail', '1280x900', base, cap, [{ ...waiver, on: 'control' }]).fails, ['heading missing: 2:Obligations'], 'a waiver for another element kind does not cover it');
  assert.deepEqual(compareRecord('market', '1280x900', base, cap, [waiver]).fails, ['heading missing: 2:Obligations'], 'a waiver is per route');
});

test('once APPLIED.json lists the migration, the waiver that names it fails the check; an absent or other listing does not', () => {
  const config = { approved: [waiver, { id: 'look', route: 'login', kind: 'pixel', ruling: 'x' }] };
  assert.deepEqual(retiredWaiverProblems(config, appliedMigrations([])), []);
  assert.deepEqual(retiredWaiverProblems(config, appliedMigrations(['0030'])), []);
  const red = retiredWaiverProblems(config, appliedMigrations(['0031']));
  assert.equal(red.length, 1);
  assert.match(red[0], /waiver w1 is until migration 0031/);
  assert.equal(retiredWaiverProblems(config, appliedMigrations({ applied: ['0031', '0032'] })).length, 1, 'the object form lists too');
});
