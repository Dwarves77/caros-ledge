// The ONE filter that cuts the committed baseline to what a UX-smoke fixture draws (the 2026-10-19 ruling "one shell filter", now covering landmarks, headings and rows as well as controls).
//
// A fixture draws a page WITHOUT the shell (the platform nav, the account menu, the notifications bell, the top bar), so the baseline records of the real route carry things the fixture can never hold. Each smoke names the cut it needs
// as a `kind`; the cut lives here, once, and a smoke has no filter of its own:
//   'account'  the account frame (/settings, /profile): landmarks from the "Account sections" region on
//   'page'     a page drawn inside the shell's <main> (dashboard, watchlist, search): landmarks from the first main on
//   'in-main'  a page whose own <h1> and regions sit inside <main> (Community): landmarks after the first main, headings from the page's own last h1
// Every kind drops the shell's controls (approved-changes.json `frameControls`, the same list the parity gate's frame routes use, plus the search box of the page frame), the shell wordmark heading, and rows: a fixture holds its own
// rows, the baseline's belong to the live corpus. An anchor the baseline does not hold is an error, never a silent fall-back to the whole record.
import { readFileSync } from 'node:fs';

import { CAPTURE_CONTRACT } from '../parity/contract.mjs';

const CONFIG = JSON.parse(readFileSync(new URL('../parity/approved-changes.json', import.meta.url), 'utf8'));
const SEARCH_CHROME = ['^combobox:Search or ask', '^button:Ask$'];
const SHELL_WORDMARK = "Caro's Ledge";

/** Returns `isShell(control)`: true when a baseline control (`{role, name}`) is shell chrome. A trailing count in the name ("Watchlist3") is ignored, as the gate ignores it. */
export function shellControl(config = CONFIG) {
  const res = [...config.frameControls, ...SEARCH_CHROME].map((re) => new RegExp(re));
  return (c) => res.some((re) => re.test(`${c.role}:${c.name.replace(/(?<=[A-Za-z])[\d,]+$/, '')}`));
}

const anchored = (baseline, kind, find, what) => {
  const at = baseline.landmarks.findIndex(find);
  if (at < 0) throw new Error(`scopeBaseline(${kind}): the baseline holds no ${what} landmark (is it a record of the right route, under the current capture contract?)`);
  return at;
};
const dedupe = (headings) => headings.filter((x, i, all) => x.text !== SHELL_WORDMARK && !(i > 0 && all[i - 1].text === x.text && all[i - 1].level === x.level));

/** The baseline record cut to what a fixture of the given kind draws. */
export function scopeBaseline(baseline, kind) {
  const isShell = shellControl();
  const controls = baseline.controls.filter((c) => !isShell(c));
  const rows = { items: [], containers: [] };
  if (kind === 'account') return { ...baseline, rows, controls, headings: dedupe(baseline.headings), landmarks: baseline.landmarks.slice(anchored(baseline, kind, (l) => (l.name ?? '').startsWith('Account sections'), '"Account sections"')) };
  if (kind === 'page') return { ...baseline, rows, controls, headings: dedupe(baseline.headings), landmarks: baseline.landmarks.slice(anchored(baseline, kind, (l) => l.role === 'main', 'main')) };
  if (kind === 'in-main') {
    const h1At = baseline.headings.map((h) => h.level).lastIndexOf(1);
    if (h1At < 0) throw new Error('scopeBaseline(in-main): the baseline holds no <h1>');
    return { ...baseline, rows, controls, headings: baseline.headings.slice(h1At), landmarks: baseline.landmarks.slice(anchored(baseline, kind, (l) => l.role === 'main', 'main') + 1) };
  }
  throw new Error(`scopeBaseline: unknown kind ${JSON.stringify(kind)}`);
}

/** True when the committed baseline was written under the capture contract this tree reads; the fixture-parity sections of a smoke run only then, and a smoke says so when they cannot. */
export function baselineIsCurrent() {
  return JSON.parse(readFileSync(new URL('../parity/baseline/index.json', import.meta.url), 'utf8')).contract === CAPTURE_CONTRACT;
}
