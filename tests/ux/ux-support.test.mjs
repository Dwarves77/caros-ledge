// The browser-free parts of the UX support (G2b): the exemption list that the layout measure reads, the one baseline filter, and the register of known silent client reads. The measure itself and the smokes run in a browser
// (the parity job); what they are given is held here, where `npm test` runs it on every push.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadExemptions } from './measure.mjs';
import { scopeBaseline, shellControl } from './shell-filter.mjs';

const exemptionsFile = (json) => {
  const f = join(mkdtempSync(join(tmpdir(), 'exempt-')), 'e.json');
  writeFileSync(f, JSON.stringify(json));
  return f;
};
const ENTRY = { selector: '.x', match: 'self', reason: 'a reason that is long enough to count' };
const GOOD = { overflow: [ENTRY], target: [ENTRY], collapsed: [ENTRY] };

test('the exemption list loads, and an entry without a reason, a match mode or a selector, or an empty kind, is refused', () => {
  assert.deepEqual(Object.keys(loadExemptions(exemptionsFile(GOOD))).sort(), ['collapsed', 'overflow', 'target']);
  assert.throws(() => loadExemptions(exemptionsFile({ ...GOOD, target: [{ ...ENTRY, reason: 'short' }] })), /carries no reason/);
  assert.throws(() => loadExemptions(exemptionsFile({ ...GOOD, target: [{ ...ENTRY, match: 'near' }] })), /must say match/);
  assert.throws(() => loadExemptions(exemptionsFile({ ...GOOD, target: [{ ...ENTRY, selector: '' }] })), /has no selector/);
  assert.throws(() => loadExemptions(exemptionsFile({ ...GOOD, overflow: [] })), /non-empty list/);
  assert.throws(() => loadExemptions(exemptionsFile({ overflow: [ENTRY], target: [ENTRY] })), /non-empty list/);
});

/** All text under src/, for the check that an exemption names something that exists. */
function srcText(dir = 'src') {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += srcText(p);
    else if (/\.(tsx?|css)$/.test(name)) out += `${readFileSync(p, 'utf8')}\n`;
  }
  return out;
}

test('every exemption of the committed list is valid and names a class or attribute that exists in src/ (a stale exemption fails), unless it is a library class and says so', () => {
  const json = JSON.parse(readFileSync(new URL('./measure-exemptions.json', import.meta.url), 'utf8'));
  const exemptions = loadExemptions();
  const text = srcText();
  for (const [kind, entries] of Object.entries(exemptions)) {
    for (const e of entries) {
      const names = [...e.selector.matchAll(/\.([A-Za-z0-9_-]+)|\[([a-z-]+)/g)].map((m) => m[1] ?? m[2]);
      const library = json[kind].find((x) => x.selector === e.selector)?.library;
      if (library) continue;
      for (const n of names) assert.ok(text.includes(n), `${kind}: "${e.selector}" names ${n}, which nothing in src/ uses: delete the exemption`);
    }
  }
});

const record = (over = {}) => ({
  landmarks: [{ role: 'complementary', name: 'Caros shell' }, { role: 'navigation', name: 'Platform' }, { role: 'main', name: '' }, { role: 'region', name: 'Account sections' }, { role: 'region', name: 'Profile' }],
  headings: [{ level: 1, text: "Caro's Ledge" }, { level: 1, text: 'Profile' }, { level: 1, text: 'Profile' }, { level: 2, text: 'Personal' }],
  controls: [{ role: 'link', name: "Caro's Ledge" }, { role: 'link', name: 'Watchlist3' }, { role: 'button', name: 'Save personal profile' }, { role: 'combobox', name: 'Search or ask across the workspace' }],
  rows: { items: [{ tag: 'div', text: 'x', width: 1, height: 1, container: 'main' }], containers: [{ label: 'main', count: 1 }] },
  ...over,
});

test('scopeBaseline cuts the record to what a fixture draws: shell controls and the wordmark go, rows are not compared, and each kind has its landmark anchor', () => {
  const account = scopeBaseline(record(), 'account');
  assert.deepEqual(account.landmarks.map((l) => l.name), ['Account sections', 'Profile']);
  assert.deepEqual(account.controls.map((c) => c.name), ['Save personal profile']);
  assert.deepEqual(account.headings, [{ level: 1, text: 'Profile' }, { level: 2, text: 'Personal' }], 'the wordmark and the repeated title are dropped once');
  assert.deepEqual(account.rows, { items: [], containers: [] });
  const page = scopeBaseline(record(), 'page');
  assert.deepEqual(page.landmarks.map((l) => l.role), ['main', 'region', 'region']);
  const inMain = scopeBaseline(record(), 'in-main');
  assert.deepEqual(inMain.landmarks.map((l) => l.name), ['Account sections', 'Profile']);
  assert.deepEqual(inMain.headings.map((h) => h.text), ['Profile', 'Personal'], 'from the page\'s own last <h1>');
});

test('scopeBaseline refuses what it cannot cut: an anchor the baseline does not hold is an error, never the whole record; so is an unknown kind', () => {
  assert.throws(() => scopeBaseline(record({ landmarks: [{ role: 'main', name: '' }] }), 'account'), /holds no "Account sections" landmark/);
  assert.throws(() => scopeBaseline(record({ landmarks: [{ role: 'region', name: 'x' }] }), 'page'), /holds no main landmark/);
  assert.throws(() => scopeBaseline(record({ headings: [{ level: 2, text: 'x' }] }), 'in-main'), /holds no <h1>/);
  assert.throws(() => scopeBaseline(record(), 'everything'), /unknown kind/);
});

test('shellControl is the shell list of approved-changes.json plus the page frame search, and ignores a trailing count in the name', () => {
  const isShell = shellControl();
  assert.equal(isShell({ role: 'link', name: 'Watchlist3' }), true);
  assert.equal(isShell({ role: 'combobox', name: 'Search or ask across the workspace' }), true);
  assert.equal(isShell({ role: 'button', name: 'Save personal profile' }), false);
});

test('the register of known silent client reads is made of findings: a status token, the slice that owes the fix and the finding', () => {
  const reg = JSON.parse(readFileSync(new URL('./known-silent-client-reads.json', import.meta.url), 'utf8'));
  for (const [screen, reads] of Object.entries(reg.screens)) {
    for (const [read, f] of Object.entries(reads)) {
      assert.match(read, /^(GET \/api\/[\w/.-]+|rest [a-z_]+|rpc [a-z_]+)$/, `${screen}: ${read}`);
      assert.ok(['CONFIRMED', 'HYPOTHESIS'].includes(f.status), `${screen} ${read}: a finding is CONFIRMED or a HYPOTHESIS (rule 14)`);
      assert.ok(f.owner.length > 3 && f.finding.length > 60, `${screen} ${read}: an owner and a finding`);
    }
  }
});

test('one four-width list for every smoke, and no smoke sleeps: readiness is the hydration marker and the network, never a fixed wait', async () => {
  const { VIEWPORTS } = await import('./harness.mjs');
  assert.deepEqual(VIEWPORTS.map(([w]) => w), [375, 768, 1024, 1280]);
  for (const name of readdirSync(new URL('.', import.meta.url)).filter((n) => n.endsWith('.mjs'))) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /waitForTimeout\(/, `${name} sleeps: wait for the effect instead (until(), settled())`);
    assert.doesNotMatch(text, /waitUntil:\s*'networkidle'/, `${name} loads with networkidle and no readiness signal: use harness.open()`);
    if (name.endsWith('-smoke.mjs')) assert.doesNotMatch(text, /^const VIEWPORTS/m, `${name} keeps a list of widths of its own`);
  }
});
