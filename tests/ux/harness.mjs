// The one harness every UX smoke runs under (G1 "the first red smoke hides the rest", G2b "sleeps instead of a readiness signal").
//
//  - `smoke(name)` returns the run: `fail(where, what)` records an offence and carries on; `check(name, fn)` runs one section and records a thrown error as a failure instead of ending the smoke; `finish(okLine)` prints
//    every failure together and exits 1 (or prints the clean line and exits 0). A smoke therefore reports everything it can see in one run, however early the first fault is.
//  - `settled(page)` is the readiness signal that replaces fixed sleeps: the shell has hydrated (`data-hydrated`, src/ui/shell/Hydrated.tsx), the network is idle, the fonts are loaded and two frames have painted.
//  - `open(browser, url, viewport, ...)` is the one way a smoke opens a page: a fresh context, page errors collected, the answer checked, the page settled.
//  - `exactlyOne(page, selector)` asserts a locator matches once; on two matches it prints the page HTML first, so the cause of a duplicate id is recorded (IMP-128).
//  - `until(condition, what)` waits for an observable effect (a request seen, a count reached) and fails with `what` when it does not come; it replaces a sleep that waited for a debounce.
//  - `VIEWPORTS` is the four widths every layout loop uses.
import { chromium } from 'playwright';

import { domSummary } from '../parity/capture.mjs';
import { ROW_SELECTOR } from '../parity/contract.mjs';

import { baselineIsCurrent } from './shell-filter.mjs';

export const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
];
export const WIDTHS = VIEWPORTS.map(([w, h]) => `${w}x${h}`).join(', ');

const SETTLE_MS = 20000;

/** Waits until the page is ready to be measured or clicked: hydrated, quiet on the network, fonts loaded, painted. */
export async function settled(page) {
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', null, { timeout: SETTLE_MS });
  await page.waitForLoadState('networkidle', { timeout: SETTLE_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Polls `condition` (sync or async) until it is true, for at most `ms`; throws `what` when it never is. */
export async function until(condition, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > end) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Asserts the locator matches exactly one element; on any other count the page HTML is printed (trimmed) so the duplicate or the missing element can be read. */
export async function exactlyOne(page, selector, what = selector) {
  const n = await page.locator(selector).count();
  if (n === 1) return page.locator(selector);
  const html = (await page.content()).replace(/\s+/g, ' ').slice(0, 6000);
  throw new Error(`${what}: expected exactly one match for ${selector}, found ${n}\n--- page HTML (first 6000 characters) ---\n${html}`);
}

/** The origin a smoke runs against: `--base <origin>`. */
function baseOf(name) {
  const at = process.argv.indexOf('--base');
  const base = at < 0 ? undefined : process.argv[at + 1];
  if (!base || base.startsWith('--')) throw new Error(`usage: ${name} --base <origin>`);
  return base;
}

/** A smoke's run: failures collected, sections that cannot end the smoke, one verdict at the end. */
export function smoke(name) {
  const failures = [];
  const fail = (where, what) => failures.push(`${where}: ${what}`);
  const check = async (section, run) => {
    try {
      await run();
    } catch (e) {
      fail(section, String(e.message ?? e).split('\n').slice(0, 4).join(' | '));
    }
  };
  const must = (condition, what) => {
    if (!condition) throw new Error(what);
  };
  const finish = (okLine) => {
    if (failures.length) {
      for (const f of failures) console.error(f);
      console.error(`${name}: ${failures.length} failure(s)`);
      process.exit(1);
    }
    console.log(`${name}: ${okLine}`);
  };
  return { base: baseOf(name), failures, fail, check, must, finish };
}

/**
 * Opens a page in a fresh context: viewport, optional `prepare(page, ctx)` (routes, cookies) before the first request, the answer must be 200, then the page is settled.
 * Returns `{ ctx, page, errors }`; `errors` collects uncaught page errors for the caller to report.
 */
export async function open(browser, url, [width, height], { prepare, expectStatus = 200 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    if (prepare) await prepare(page, ctx);
    const res = await page.goto(url, { waitUntil: 'load' });
    if (!res || res.status() !== expectStatus) throw new Error(`${url} answered ${res?.status()}`);
    await settled(page);
  } catch (e) {
    await ctx.close();
    throw e;
  }
  return { ctx, page, errors };
}

/** The page recorded the way the parity capture records it (landmarks with names, headings, controls, every list row); the fixture-parity sections compare this with the baseline. */
export const summarise = (page) => page.evaluate(domSummary, { rowSelector: ROW_SELECTOR });

/** True when the fixture-parity sections can run; otherwise records the failure that says why (the baseline predates the capture contract this tree reads) and returns false. */
export function parityReady(run, where = 'fixture parity') {
  if (baselineIsCurrent()) return true;
  run.fail(where, 'not run: the committed baseline was written under an older capture contract; recapture it (tests/parity/baseline/README.md) and the comparison runs');
  return false;
}

export { chromium };
