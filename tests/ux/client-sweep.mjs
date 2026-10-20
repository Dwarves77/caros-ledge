// The client-read sweep (G5, INV-263 for the reads a server page cannot see). The server sweep (tests/_support/page-sweep.ts) draws a page and refuses each database read; a read a CLIENT part makes after hydration (the Watch
// membership, the relevance banner, the recalculation notices, the settings bundle) never reaches it. This sweep does the same in the browser, through the same rule: a screen is opened healthy and every read it makes is
// recorded (a GET of /api/**, a Supabase REST read of /rest/v1/<table>, an rpc), then the screen is opened again once per read with THAT read answered 503, and the page must say so: more of the stated-failure vocabulary
// than the healthy draw carried ("did not load", "could not", "Try again", "Retry", "unavailable"). A refused read that changes nothing, or changes the page without saying why, is silent and fails the smoke.
//
// Like the server sweep it can itself fail: a screen that already states a failure when healthy proves nothing, a screen that makes no read is vacuous, and the silent set must equal the committed register
// (tests/ux/known-silent-client-reads.json) exactly, so a new silent read fails and a fixed one must leave the file.
import { readFileSync } from 'node:fs';

import { settled } from './harness.mjs';

const REGISTER = JSON.parse(readFileSync(new URL('./known-silent-client-reads.json', import.meta.url), 'utf8'));
/** The same vocabulary as tests/_support/page-sweep.ts STATED. */
export const STATED = /did not load|could not be loaded|could not|unavailable|Try again|Retry|Application error/gi;
export const statedCount = (text) => (text.match(STATED) ?? []).length;

/** The reads the shell makes on every page and states itself (AppShell shellNotes answers a failed identity lookup with a note and Retry); a fixture mount is chromeless, so the screen under sweep is not the one to state them. */
export const SHELL_READS = ['GET /api/auth/identity'];

/** What a failing route answers: the customer sentence every route's 503 carries (LookupError, dbError). A part that shows the server's sentence has stated the failure; a part that shows nothing has not. */
const REFUSAL_SENTENCE = 'This could not be read just now. Try again.';

/** The key of a read a screen makes: `GET /api/x`, `GET rest/<table>` or `rpc/<name>`; null for anything that is not a read. */
function readKey(request) {
  const url = new URL(request.url());
  const method = request.method();
  if (url.pathname.startsWith('/rest/v1/rpc/')) return `rpc ${url.pathname.slice('/rest/v1/rpc/'.length)}`;
  if (url.pathname.startsWith('/rest/v1/')) return method === 'GET' || method === 'HEAD' ? `rest ${url.pathname.slice('/rest/v1/'.length).split('/')[0]}` : null;
  if (url.pathname.startsWith('/api/') && method === 'GET') return `GET ${url.pathname}`;
  return null;
}

async function drawn(browser, spec, refuse) {
  const ctx = await browser.newContext({ viewport: { width: spec.viewport[0], height: spec.viewport[1] } });
  const page = await ctx.newPage();
  const reads = new Set();
  try {
    await spec.prepare(page, ctx);
    // Registered after the smoke's own mock, so it answers first: the refused read gets a stated 503, every other request falls through to the mock.
    await page.route('**/*', (route) => {
      const key = readKey(route.request());
      if (key && refuse === key) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'retry-after': '1' }, body: JSON.stringify({ error: REFUSAL_SENTENCE }) });
      return route.fallback();
    });
    page.on('request', (r) => {
      const key = readKey(r);
      if (key) reads.add(key);
    });
    const res = await page.goto(spec.url, { waitUntil: 'load' });
    if (!res || res.status() !== 200) throw new Error(`${spec.url} answered ${res?.status()}`);
    await settled(page);
    if (spec.after) await spec.after(page);
    await settled(page);
    return { text: await page.evaluate(() => document.body.innerText), reads };
  } finally {
    await ctx.close();
  }
}

/**
 * Sweeps one screen. `spec`: { name, url, viewport, prepare(page, ctx), after?(page), ignore?: string[], expectStated?: number }. Returns { reads, silent, problems }; `ignore` names reads that are not the screen's to state
 * (the identity lookup the shell makes, which the shell states), each with its reason in the smoke.
 */
export async function sweepClientReads(browser, spec) {
  const healthy = await drawn(browser, spec, null);
  const problems = [];
  // A fixture can carry a failure state ON PURPOSE (a part drawn failed to show its note); the smoke declares how many statements it holds, and the count must match exactly. Any other healthy statement proves nothing.
  const expected = spec.expectStated ?? 0;
  if (statedCount(healthy.text) !== expected) problems.push(`the healthy screen holds ${statedCount(healthy.text)} stated failure(s) (${(healthy.text.match(STATED) ?? []).join(', ')}) where ${expected} are declared: a refused read can only be told from them by a larger count, so the sweep proves nothing until the screen is healthy`);
  const reads = [...healthy.reads].filter((k) => !(spec.ignore ?? []).includes(k)).sort();
  if (!reads.length) problems.push('the screen makes no read: the sweep is vacuous');
  const silent = [];
  for (const key of reads) {
    const refused = await drawn(browser, spec, key);
    if (!(refused.text !== healthy.text && statedCount(refused.text) > statedCount(healthy.text))) silent.push(key);
  }
  return { reads, silent, problems };
}

/** Runs the sweep for a screen under a smoke and records what it finds: problems, and any difference between the silent set and the register. */
export async function checkClientReads(run, browser, spec) {
  const result = await sweepClientReads(browser, spec);
  const where = `client sweep ${spec.name}`;
  for (const p of result.problems) run.fail(where, p);
  const known = Object.keys(REGISTER.screens[spec.name] ?? {}).sort();
  const silent = result.silent.sort();
  for (const k of silent.filter((s) => !known.includes(s))) run.fail(where, `a refused read draws a screen with no stated failure: ${k} (a new silent read; state it with Retry, or register it as a finding in tests/ux/known-silent-client-reads.json)`);
  for (const k of known.filter((s) => !silent.includes(s))) run.fail(where, `${k} is in tests/ux/known-silent-client-reads.json but its refusal is now stated: remove it from the register`);
  return result;
}
