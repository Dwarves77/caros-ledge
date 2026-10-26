// How the live checks load one page (LIVE-RL-1). Three rules, none of them a word match:
//  1. A UI failure is a TYPED DOM element, never text: the app marks every stated failure it draws (UI_FAILURE_SELECTOR below: the state-note alert, a failed list, the page failure, and the framework's own error overlay).
//     The element's marker and its text (200 characters) are reported as diagnostics only; the test is that the element exists.
//  2. An API failure is HTTP status only: every same-origin /api/ response of the load with status >= 400 is recorded (path and status).
//  3. The app limits a signed-in account to 60 requests per 60 seconds across every deployment (src/core/http/rate-limit.ts), so a 429 is the one status that is waited out: the page is reloaded ONCE after the server's Retry-After
//     (capped at RETRY_CAP_MS). A second 429, or any other failure status, stays a failure. Retries are counted on `stats` and logged.
export const UI_FAILURE_SELECTOR = '[data-part="state-note"][role="alert"], [data-list-state="failed"], [data-part="page-failure"], #__next-build-watcher, nextjs-portal';
export const RETRY_CAP_MS = 65000;
export const DIAGNOSTIC_CHARS = 200;

/** Milliseconds to wait for a Retry-After value (seconds, or an HTTP date); the cap when it is absent or unreadable; never more than the cap. */
export function retryWaitMs(retryAfter, nowMs = Date.now()) {
  const raw = String(retryAfter ?? "").trim();
  let ms = null;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else if (raw) {
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) ms = Math.max(0, at - nowMs);
  }
  return Math.min(ms ?? RETRY_CAP_MS, RETRY_CAP_MS);
}

export const newStats = () => ({ retries: 0, waitedMs: 0 });
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `visit()` loads the page once and answers { status, finalUrl, uiFailures, apiFailures } (or { error }). When any API response of that load was 429 the page is loaded once more after the longest Retry-After; the second load's
 * answer stands whatever it is. 429 is the only status retried.
 */
export async function loadWithRetry(visit, { stats = newStats(), sleep = sleepFor, log = console.log, label = "page", now = Date.now } = {}) {
  const first = await visit();
  const throttled = (first?.apiFailures ?? []).filter((f) => f.status === 429);
  if (throttled.length === 0) return first;
  const waitMs = Math.max(...throttled.map((f) => retryWaitMs(f.retryAfter, now())));
  stats.retries += 1;
  stats.waitedMs += waitMs;
  log(`  rate-limited (429 on ${throttled.map((f) => f.path).join(", ")}): ${label} reloaded once after ${Math.round(waitMs / 1000)} s`);
  await sleep(waitMs);
  return visit();
}

/** One load in a Playwright context: the page's same-origin /api/ responses with status >= 400, and the typed failure elements in the DOM once the network is idle. */
export async function visitOnce(context, base, path) {
  const origin = new URL(base).origin;
  const page = await context.newPage();
  try {
    const apiFailures = [];
    page.on("response", (r) => {
      const url = new URL(r.url());
      if (url.origin === origin && url.pathname.startsWith("/api/") && r.status() >= 400) apiFailures.push({ path: url.pathname, status: r.status(), retryAfter: r.headers()["retry-after"] });
    });
    const res = await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const sectionHeads = await page.$$eval('[data-audit="detail-section-head"]', (els) => els.length);
    const uiFailures = await page.$$eval(
      UI_FAILURE_SELECTOR,
      (els, chars) => els.map((e) => ({ marker: e.getAttribute("data-part") ?? (e.getAttribute("data-list-state") ? `data-list-state=${e.getAttribute("data-list-state")}` : e.id || e.tagName.toLowerCase()), text: (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, chars) })),
      DIAGNOSTIC_CHARS,
    );
    return { status: res?.status() ?? 0, finalUrl: page.url(), uiFailures, apiFailures, sectionHeads };
  } finally {
    await page.close();
  }
}

/** The page load the live checks use: visitOnce with the one 429 reload. A browser error is an { error } answer, never a throw. */
export async function loadPage(context, base, path, opts = {}) {
  try {
    return await loadWithRetry(() => visitOnce(context, base, path), { ...opts, label: path });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
