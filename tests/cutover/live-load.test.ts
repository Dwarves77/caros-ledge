// LIVE-RL-1: how the live checks load a page. The 429 reload (loadWithRetry) is tried against a fake visit; the response filter and the typed failure selector (visitOnce) against a fake Playwright context.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error plain .mjs modules
import { pageFinding } from "../../scripts/ci/live/checks.mjs";
// @ts-expect-error plain .mjs modules
import { loadPage, loadWithRetry, newStats, RETRY_CAP_MS, retryWaitMs, UI_FAILURE_SELECTOR, visitOnce } from "../../scripts/ci/live/load.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const rendered = { status: 200, finalUrl: "https://x.test/regulations", uiFailures: [], apiFailures: [] };
const throttled = { ...rendered, uiFailures: [{ marker: "state-note", text: "Your watchlist did not load." }], apiFailures: [{ path: "/api/watchlist", status: 429, retryAfter: "12" }] };
/** A visit that answers the given loads in order and counts its calls. */
const visits = (...answers: Any[]) => {
  const calls = { n: 0 };
  return { calls, visit: async () => answers[Math.min(calls.n++, answers.length - 1)] };
};
const run = async (...answers: Any[]) => {
  const { calls, visit } = visits(...answers);
  const stats = newStats();
  const slept: number[] = [];
  const logged: string[] = [];
  const page = await loadWithRetry(visit, { stats, sleep: async (ms: number) => void slept.push(ms), log: (l: string) => void logged.push(l), label: "/regulations" });
  return { page, calls: calls.n, stats, slept, logged, finding: pageFinding("pages", "/regulations", page) };
};

test("a 429 followed by a 200 passes after exactly one reload, waiting the server's Retry-After, and the retry is counted and printed", async () => {
  const r = await run(throttled, rendered);
  assert.equal(r.calls, 2);
  assert.equal(r.finding, null);
  assert.deepEqual(r.slept, [12000]);
  assert.equal(r.stats.retries, 1);
  assert.match(r.logged.join("\n"), /rate-limited \(429 on \/api\/watchlist\): \/regulations reloaded once after 12 s/);
});

test("a 429 followed by a 429 fails: one reload only, and the finding names the read", async () => {
  const r = await run(throttled, throttled);
  assert.equal(r.calls, 2);
  assert.equal(r.stats.retries, 1);
  assert.equal(r.finding.severity, "fail");
  assert.match(r.finding.text, /\/api\/watchlist 429/);
});

test("a 500 is not retried: one load, no wait, a failure naming the read", async () => {
  const r = await run({ ...rendered, apiFailures: [{ path: "/api/workspace/tags", status: 500 }] }, rendered);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.slept, []);
  assert.equal(r.stats.retries, 0);
  assert.match(r.finding.text, /\/api\/workspace\/tags 500/);
});

test("a 503 with a Retry-After header and a typed failure element are not retried either; a clean load is loaded once", async () => {
  const r503 = await run({ ...rendered, apiFailures: [{ path: "/api/workspace/tags", status: 503, retryAfter: "1" }] });
  assert.equal(r503.calls, 1);
  const ui = await run({ ...rendered, uiFailures: [{ marker: "page-failure", text: "x" }] });
  assert.equal(ui.calls, 1);
  assert.equal(ui.finding.severity, "fail");
  assert.equal((await run(rendered)).calls, 1);
});

test("the wait is the longest Retry-After of the 429s, capped at 65 s; a missing or unreadable header waits the cap; a past date waits 0", async () => {
  assert.equal(RETRY_CAP_MS, 65000);
  assert.equal(retryWaitMs("7"), 7000);
  assert.equal(retryWaitMs("3600"), 65000);
  assert.equal(retryWaitMs(undefined), 65000);
  assert.equal(retryWaitMs("soon"), 65000);
  assert.equal(retryWaitMs("Mon, 26 Oct 2026 09:37:10 GMT", Date.parse("Mon, 26 Oct 2026 09:37:00 GMT")), 10000);
  assert.equal(retryWaitMs("Mon, 26 Oct 2026 09:30:00 GMT", Date.parse("Mon, 26 Oct 2026 09:37:00 GMT")), 0);
  const both = { ...throttled, apiFailures: [{ path: "/api/a", status: 429, retryAfter: "5" }, { path: "/api/b", status: 429, retryAfter: "20" }] };
  assert.deepEqual((await run(both, rendered)).slept, [20000]);
});

// ---- the page load against a fake browser ----
const resp = (url: string, status: number, headers: Record<string, string> = {}) => ({ url: () => url, status: () => status, headers: () => headers });
/** A fake context whose pages answer the scripted loads in order: the responses each load emits and the failure elements the DOM holds. */
function fakeContext(loads: Array<{ responses: Any[]; failures?: Any[]; status?: number }>) {
  const seen = { selector: "", pages: 0 };
  return {
    seen,
    newPage: async () => {
      const load = loads[Math.min(seen.pages++, loads.length - 1)]!;
      let on: (r: Any) => void = () => {};
      return {
        on: (_e: string, cb: (r: Any) => void) => void (on = cb),
        goto: async () => (load.responses.forEach(on), { status: () => load.status ?? 200 }),
        waitForLoadState: async () => {},
        url: () => "https://x.test/regulations",
        $eval: async () => null,
        $$eval: async (selector: string) => ((seen.selector = selector), load.failures ?? []),
        close: async () => {},
      };
    },
  };
}
const BASE = "https://x.test";

test("the load records only same-origin /api/ responses with status >= 400 (path without query, status), and reads the typed failure elements with the one selector", async () => {
  const ctx = fakeContext([{ responses: [resp("https://x.test/api/ok?a=1", 200), resp("https://x.test/api/listings/rest?page=2", 500), resp("https://x.test/_next/static/a.js", 404), resp("https://elsewhere.test/api/x", 500), resp("https://x.test/api/redirect", 307), resp("https://x.test/api/saved-views", 401)], failures: [{ marker: "state-note", text: "t" }] }]);
  const page = await visitOnce(ctx, BASE, "/regulations");
  assert.deepEqual(page.apiFailures.map((f: Any) => [f.path, f.status]), [["/api/listings/rest", 500], ["/api/saved-views", 401]]);
  assert.deepEqual(page.uiFailures, [{ marker: "state-note", text: "t" }]);
  assert.equal(ctx.seen.selector, UI_FAILURE_SELECTOR);
  for (const typed of ['[data-part="state-note"][role="alert"]', '[data-list-state="failed"]', '[data-part="page-failure"]', "#__next-build-watcher", "nextjs-portal"]) assert.ok(UI_FAILURE_SELECTOR.includes(typed), typed);
  assert.ok(!/did not|could not|wrong/i.test(UI_FAILURE_SELECTOR), "the selector holds no word list");
});

test("loadPage over a fake browser: a throttled first load is reloaded once and the second load's answer stands; a page that throws is an error answer, not a throw", async () => {
  const slept: number[] = [];
  const opts = { sleep: async (ms: number) => void slept.push(ms), log: () => {}, stats: newStats() };
  const healed = await loadPage(fakeContext([{ responses: [resp("https://x.test/api/watchlist", 429, { "retry-after": "3" })], failures: [{ marker: "state-note", text: "x" }] }, { responses: [resp("https://x.test/api/watchlist", 200)] }]), BASE, "/regulations", opts);
  assert.equal(pageFinding("pages", "/regulations", healed), null);
  assert.deepEqual(slept, [3000]);
  assert.equal(opts.stats.retries, 1);
  const stuck = await loadPage(fakeContext([{ responses: [resp("https://x.test/api/watchlist", 429, { "retry-after": "3" })] }, { responses: [resp("https://x.test/api/watchlist", 429, { "retry-after": "3" })] }]), BASE, "/regulations", { ...opts, stats: newStats() });
  assert.match(pageFinding("pages", "/regulations", stuck).text, /\/api\/watchlist 429/);
  const broken = await loadPage({ newPage: async () => { throw new Error("browser closed"); } }, BASE, "/regulations", opts);
  assert.match(pageFinding("pages", "/regulations", broken).text, /did not answer: browser closed/);
});
