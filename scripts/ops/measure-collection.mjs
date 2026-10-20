// Measures how the registered sources fare under the collection ladder (R2c). Read-only, stores no body: one result row per source (status, class, channel), then the four counts served, substituted, access_requested and deferred, with not_found and unreachable beside them so the rest of the registry is accounted for.
//   node scripts/ops/measure-collection.mjs --registry register.json --out <dir> [--sample] [--limit N] [--browser]
//   node scripts/ops/measure-collection.mjs --db --out <dir>           (reads public.sources through DATABASE_URL in a read-only transaction)
// --registry takes a JSON array of sources (or { sources: [...] }) with id, url, effective_tier, access_method, paywalled, api_endpoint_url, rss_feed_url, sitemap_url. --sample reproduces the 2026-10-19 sample (every source of
// tier 1 or 2, then at most 5 per host of the rest) so the counts compare with docs/audits/2026-10-20-collection-under-honest-identity.md.
// The identity is the declared one (CarosLedge/1.0 (+https://carosledge.com/bot)), robots.txt is asked before every page, and the per-host gap is one second (the host's Crawl-delay when longer). The browser tier runs only with --browser AND
// on the Actions runner (GITHUB_ACTIONS=true); anywhere else a walled source is counted `awaiting_browser` (deferred), never concluded. Exit 0 when the measurement completed, 1 on a usage error.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

register("./../lib/ts-hooks.mjs", import.meta.url, { data: {} });

const { values } = parseArgs({ options: { registry: { type: "string" }, db: { type: "boolean", default: false }, out: { type: "string" }, sample: { type: "boolean", default: false }, limit: { type: "string" }, browser: { type: "boolean", default: false }, concurrency: { type: "string", default: "8" } } });
if ((!values.registry && !values.db) || !values.out) {
  console.error("usage: node scripts/ops/measure-collection.mjs (--registry <file> | --db) --out <dir> [--sample] [--limit N] [--browser]");
  process.exit(1);
}

const { honestFetch } = await import("../../src/core/fetch/honest.ts");
const { fetchDocument, isWallStatus } = await import("../../src/core/fetch/policy.ts");
const { BODY_CLASS, classifyBody, isStorableClass, toText } = await import("../../src/core/fetch/classify-body.ts");
const { closeBrowser, fetchBrowser } = await import("../../src/core/fetch/headless.ts");
const { identifiersOf, substituteCandidates } = await import("../../src/core/sources/publishers.ts");
const { apiEndpointFor } = await import("../../src/core/fetch/api.ts");

async function load() {
  if (values.registry) {
    const j = JSON.parse(readFileSync(values.registry, "utf8"));
    return Array.isArray(j) ? j : j.sources;
  }
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("set default_transaction_read_only = on");
    return (await c.query("select id, name, url, status, effective_tier, access_method, paywalled, api_endpoint_url, rss_feed_url, sitemap_url from public.sources")).rows;
  } finally {
    await c.end();
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
};
let sources = (await load()).filter((s) => !["archived", "retired"].includes(s.status));
if (values.sample) {
  const seen = new Map();
  const head = sources.filter((s) => s.effective_tier != null && s.effective_tier <= 2);
  const rest = [];
  for (const s of [...sources].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (head.includes(s)) continue;
    const n = seen.get(hostOf(s.url)) ?? 0;
    if (n < 5) {
      seen.set(hostOf(s.url), n + 1);
      rest.push(s);
    }
  }
  sources = [...head, ...rest];
}
if (values.limit) sources = sources.slice(0, Number(values.limit));

// A PDF engine that fails inside a worker must cost one source, never the run.
process.on("unhandledRejection", (e) => console.error(`  unhandled rejection: ${e instanceof Error ? e.message : String(e)}`));
process.on("uncaughtException", (e) => console.error(`  uncaught exception: ${e instanceof Error ? e.message : String(e)}`));

const runner = process.env.GITHUB_ACTIONS === "true";
// An operator-dispatched measurement is a manual run: it passes the hold as the signed manual caller (src/core/fetch/hold.ts), the same door a manual intake uses.
const deps = { env: process.env, now: () => new Date(), caller: "manual-intake-run" };
const get = honestFetch(deps);
const getApi = honestFetch(deps, { api: true });

/** The measurement asks whether a PDF is reachable, not what its text layer says: a fetched PDF counts as read, and the PDF engine (heavy, and not a collection channel) is not started. */
const pdfReached = async (bytes) => ({ text: `a PDF document of ${bytes.byteLength} bytes was reached; its text layer is not read by this measurement. `.repeat(4), pages: null, title: null });

/** One document read through a guarded fetch: { status, cls, refusal } and never the body. */
async function read(url, fetchImpl, headers) {
  const out = await fetchDocument(url, { fetchImpl, maxChars: 3_000_000, timeoutMs: 20_000, minChars: 0, markers: [], extractPdf: pdfReached, ...(headers ? { headers } : {}) });
  if (!out.ok) return { status: out.status, refusal: out.reason, rule: out.rule ?? null, wall: out.reason === "robots_disallowed" || (out.reason === "robots_unknown" && out.identityRefused === true) || (out.reason === "non_200" && (isWallStatus(out.status) || out.status === 202)) || out.reason === "error_marker", deferred: (out.reason === "robots_unknown" && !out.identityRefused) || out.reason === "host_busy", cls: null };
  const cls = classifyBody(toText(out.text), { status: out.status }).class;
  return { status: out.status, refusal: null, wall: false, deferred: false, cls, ok: isStorableClass(cls), jsShell: cls === BODY_CLASS.JS_SHELL };
}

async function measure(s) {
  const attempts = [];
  const note = (channel, r) => attempts.push({ channel, status: r.status ?? null, cls: r.cls ?? null, refusal: r.refusal ?? null });
  const row = (state, channel, extra = {}) => ({ id: s.id, host: hostOf(s.url), tier: s.effective_tier ?? null, state, channel, attempts, ...extra });
  if (s.paywalled) return row("paywalled", null, { cause: "paywalled" });
  const direct = await read(s.url, get);
  note("direct", direct);
  if (direct.ok) return row("served", "direct");
  const declared = [];
  if (s.rss_feed_url) declared.push(["feed", s.rss_feed_url, get]);
  const apiUrl = s.api_endpoint_url ?? (apiEndpointFor(s.url) ? s.url : null);
  if (apiUrl) declared.push(["api", apiUrl, getApi]);
  for (const [channel, url, f] of declared) {
    const r = await read(url, f);
    note(channel, r);
    if (r.ok) return row("served", channel);
  }
  const disallowed = direct.refusal === "robots_disallowed";
  let browser = null;
  if (values.browser && runner && !disallowed && (direct.wall || direct.jsShell || direct.deferred)) {
    const b = await fetchBrowser(s.url, deps, { max: 3_000_000, paywalled: false });
    browser = b.needsHeadless ? "needs_headless" : b.refusal ? b.refusal.reason : classifyBody(b.text, { status: b.status }).class;
    attempts.push({ channel: "browser", status: b.status ?? null, cls: b.needsHeadless ? null : b.text ? classifyBody(b.text, { status: b.status }).class : null, refusal: b.refusal?.reason ?? null });
    if (b.text && isStorableClass(classifyBody(b.text, { status: b.status }).class)) return row("served", "browser");
  }
  const ids = identifiersOf(s.url);
  const subs = substituteCandidates(ids, { env: process.env, today: new Date().toISOString().slice(0, 10), refusingHost: hostOf(s.url).replace(/^www\./, "") });
  for (const c of subs.use) {
    const r = await read(c.url, c.entry.channel === "api" ? getApi : get, c.headers);
    note("substitute", r);
    if (r.ok) return row("substituted", "substitute", { substituteHost: c.entry.host });
  }
  if (direct.deferred) return row("deferred", null, { cause: direct.refusal });
  const wallOrJs = direct.wall || direct.jsShell;
  if (wallOrJs && !(values.browser && runner) && !disallowed) return row("deferred", null, { cause: "awaiting_browser", browser: "not_run" });
  if (wallOrJs || disallowed) return row("access_requested", null, { cause: disallowed ? "robots_disallowed" : "refused", rule: direct.rule ?? null, browser });
  if (direct.status === 404 || direct.status === 410) return row("not_found", null, { cause: `http_${direct.status}` });
  return row("unreachable", null, { cause: direct.refusal ?? `body_${direct.cls ?? "unread"}_http_${direct.status ?? "none"}` });
}

const byHost = new Map();
for (const s of sources) byHost.set(hostOf(s.url), [...(byHost.get(hostOf(s.url)) ?? []), s]);
const queue = [...byHost.values()];
const results = [];
let done = 0;
const t0 = Date.now();
async function worker() {
  for (let group = queue.shift(); group; group = queue.shift()) {
    for (const s of group) {
      try {
        results.push(await measure(s));
      } catch (e) {
        results.push({ id: s.id, host: hostOf(s.url), tier: s.effective_tier ?? null, state: "deferred", channel: null, attempts: [], cause: `measure error: ${e instanceof Error ? e.message : String(e)}` });
      }
      if (++done % 100 === 0) console.log(`  ${done}/${sources.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
await closeBrowser(deps);

const count = (f) => results.filter(f).length;
const causes = {};
for (const r of results) if (r.cause) causes[r.cause] = (causes[r.cause] ?? 0) + 1;
const summary = {
  measuredAt: new Date().toISOString(),
  identity: "CarosLedge/1.0 (+https://carosledge.com/bot)",
  browserTier: values.browser && runner ? "ran" : "not run (needs --browser on the Actions runner)",
  sources: results.length,
  hosts: byHost.size,
  served: count((r) => r.state === "served"),
  servedBy: Object.fromEntries(["direct", "feed", "api", "browser"].map((c) => [c, count((r) => r.state === "served" && r.channel === c)])),
  substituted: count((r) => r.state === "substituted"),
  access_requested: count((r) => r.state === "access_requested"),
  deferred: count((r) => r.state === "deferred"),
  paywalled: count((r) => r.state === "paywalled"),
  not_found: count((r) => r.state === "not_found"),
  unreachable: count((r) => r.state === "unreachable"),
  causes,
  seconds: Math.round((Date.now() - t0) / 1000),
  note: "no body is stored: each row carries the status, the body class and the channel only",
};
mkdirSync(values.out, { recursive: true });
writeFileSync(`${values.out}/results.json`, JSON.stringify(results));
writeFileSync(`${values.out}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
