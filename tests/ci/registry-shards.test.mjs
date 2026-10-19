// The mutants registry is sharded per lane (R1c): tests/mutants/registry.json plus every tests/mutants/registry/*.json is ONE registry. A shard entry is loaded, checked, counted and run exactly like one in registry.json;
// a duplicate id across two files and an empty or non-array shard are registry problems that name the files. Each case below runs on a throwaway repository (a gate of its own), never on this tree's registry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { loadRegistry, registryFiles, registryProblems } from '../../scripts/ci/mutants/registry.mjs';
import { runOne } from '../../scripts/ci/mutants.mjs';

const mutant = (over) => ({ id: 'a', gate: 'no-bad-word', apply: [{ file: 'data.txt', find: 'good', replace: 'BAD' }], expect: 'red', closes: ['K:1'], ...over });
const second = (over) => mutant({ id: 'b', gate: 'second-gate', ...over });
const inventory = ['no-bad-word', 'second-gate'];

/** A repository with registry.json (mutant `a` for gate no-bad-word), the files the mutants edit, and the shards given as { name: json text }. */
function repo(shards = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shards-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('package.json', JSON.stringify({ scripts: { 'no-bad-word': 'node check.mjs', 'second-gate': 'node check.mjs' } }));
  put('check.mjs', "import { readFileSync } from 'node:fs';\nconst t = readFileSync('data.txt', 'utf8');\nif (t.includes('BAD')) { console.error('data.txt:1: contains BAD'); process.exit(1); }\nconsole.log('clean');\n");
  put('data.txt', 'good\nline two\n');
  put('tests/mutants/registry.json', JSON.stringify([mutant()]));
  for (const [name, text] of Object.entries(shards)) put(`tests/mutants/registry/${name}`, text);
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@invalid.example'], ['config', 'core.autocrlf', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'base']]) execFileSync('git', args, { cwd: dir });
  return dir;
}

test('INV-R1c-1: an entry in a shard is loaded after registry.json, covers its gate, is counted and is run like one in registry.json', () => {
  const dir = repo({ 'r2b.json': JSON.stringify([mutant({ id: 'c' })]), 'r2a.json': JSON.stringify([second()]), 'README.md': 'not a shard\n' });
  const registry = loadRegistry(dir);
  assert.deepEqual(registry.map((m) => m.id), ['a', 'b', 'c'], 'registry.json first, then the shards sorted by name; the README is not a shard');
  assert.equal(registryFiles(registry), 3);
  assert.deepEqual(registryProblems(registry, inventory, dir), [], 'gate second-gate is covered by the shard entry alone');
  assert.match(registryProblems(loadRegistry(repo()), inventory, dir).join('|'), /gate second-gate has no registered mutant/, 'without the shard the gate has none');
  const row = runOne(dir, registry.find((m) => m.id === 'b'));
  assert.equal(row.verdict, 'red');
  assert.equal(readFileSync(join(dir, 'data.txt'), 'utf8'), 'good\nline two\n', 'restored');
});

test('INV-R1c-1: an entry that is malformed or stale is reported against the shard that holds it, with its place in that file', () => {
  const dir = repo({ 'r2a.json': JSON.stringify([second(), second({ id: 'e', apply: [{ file: 'data.txt', find: 'gone', replace: 'x' }], gate: 'no-bad-word' }), mutant({ id: 'f', expect: 'green' })]) });
  const text = registryProblems(loadRegistry(dir), inventory, dir).join('\n');
  assert.match(text, /tests\/mutants\/registry\/r2a\.json: e is stale/);
  assert.match(text, /tests\/mutants\/registry\/r2a\.json #2 \(f\): expect must be "red"/);
});

test('INV-R1c-2: a duplicate id across two files is a problem that names both files (and one inside a file names it twice)', () => {
  const dir = repo({ 'r2a.json': JSON.stringify([second({ id: 'a' })]) });
  const problems = registryProblems(loadRegistry(dir), inventory, dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^tests\/mutants\/registry\/r2a\.json: duplicate id a, also in tests\/mutants\/registry\.json$/);
  const twice = repo({ 'r2a.json': JSON.stringify([second(), second()]) });
  assert.match(registryProblems(loadRegistry(twice), inventory, twice).join('|'), /r2a\.json: duplicate id b, also in tests\/mutants\/registry\/r2a\.json/);
});

test('INV-R1c-3: an empty shard, a shard that is not an array and a shard that is not JSON are each a problem naming the file; the other entries still load', () => {
  const dir = repo({ 'r2a.json': '[]', 'r2b.json': '{"id":"x"}', 'r2c.json': '[', 'r2d.json': JSON.stringify([second()]) });
  const registry = loadRegistry(dir);
  assert.deepEqual(registry.map((m) => m.id), ['a', 'b']);
  const problems = registryProblems(registry, inventory, dir);
  assert.equal(problems.length, 3);
  for (const name of ['r2a', 'r2b', 'r2c']) assert.ok(problems.some((p) => p.startsWith(`tests/mutants/registry/${name}.json: `)), name);
});

test('a repository with no shard directory, and a registry.json that is not an array, load as before', () => {
  const dir = repo();
  assert.equal(registryFiles(loadRegistry(dir)), 1);
  writeFileSync(join(dir, 'tests/mutants/registry.json'), '{}');
  assert.throws(() => loadRegistry(dir), /must be an array of mutants/);
  assert.equal(registryFiles([]), 1, 'a plain array is one file');
});
