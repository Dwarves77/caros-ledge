// R2c C3, C4, C5 and addendum B: the collection ladder (declared channel, direct under the honest identity, the browser tier, a substitute publisher, an access request) and the browser tier's four conditions.
// INV-R2c-4 (a refused source with a registered feed is read from the feed), INV-R2c-5 (a CELEX fixture refused at its first publisher is captured from the second, source_id = the second's row).
import assert from "node:assert/strict";
import { test } from "node:test";

import { closeBrowser, fetchBrowser, type BrowserDeps, type BrowserLike } from "@/core/fetch/headless";
import { escalateFetch, NEEDS_HEADLESS, type LadderDeps } from "@/core/fetch/ladder";
import { collectRefused } from "@/features/sources/collect";
import { credentialGaps, identifiersOf, substituteCandidates } from "@/core/sources/publishers";

import { memoryDb } from "../_support/memory-db.ts";
import { routed } from "../_support/net.ts";

const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);
const ok = (text = prose(20)) => ({ status: 200, text, truncated: false, fullLength: text.length, cap: 0 });
const wall = (status = 403) => ({ status, text: "", truncated: false, fullLength: 0, cap: 0 });
const policy = (reason: "robots_disallowed" | "robots_unknown", detail = "robots") => ({ status: 0, text: "", truncated: false, fullLength: 0, cap: 0, refusal: { ok: false as const, reason, transient: reason === "robots_unknown", status: null, contentType: "", finalUrl: null, pdfBytes: null, detail } });
const publicHost = async () => ["93.184.216.34"];

test("INV-R2c-4: a source refused on the honest identity with a registered feed is read from the feed, and the record names both channels", async () => {
  const v = await escalateFetch("https://agency.gov/rule", { source: { rss_feed_url: "https://agency.gov/feed.xml", access_method: "scrape" }, directFetch: async () => wall(), feedFetch: async () => ok(), browserFetch: async () => ok() });
  assert.equal(v.outcome, "content");
  assert.equal(v.transport, "feed");
  assert.deepEqual(v.attempts.map((a) => a.transport), ["direct", "feed"]);
  assert.equal(v.attempts[0]?.class, "http_403");
});
test("a source whose access method is rss or api reads that declared channel first, ahead of the static api-host table; others read the page first", async () => {
  const order: string[] = [];
  const deps = (method: string): LadderDeps => ({ source: { rss_feed_url: "https://agency.gov/feed.xml", api_endpoint_url: "https://agency.gov/api", access_method: method }, directFetch: async () => (order.push("direct"), ok()), feedFetch: async () => (order.push("feed"), ok()), apiFetch: async () => (order.push("api"), wall()) });
  await escalateFetch("https://agency.gov/rule", deps("rss"));
  assert.deepEqual(order.splice(0), ["api", "feed"]);
  await escalateFetch("https://agency.gov/rule", { ...deps("scrape"), source: { rss_feed_url: "https://agency.gov/feed.xml", access_method: "scrape" } });
  assert.deepEqual(order.splice(0), ["direct"]);
  const v = await escalateFetch("https://www.federalregister.gov/documents/2023/05/01/2023-12345/x", { directFetch: async () => (order.push("direct"), ok()), apiFetch: async () => (order.push("api"), ok()) });
  assert.deepEqual([order.splice(0), v.transport], [["api"], "api"], "an API host routes to its API first");
});
test("a 403 is final for its channel: the next channel is tried, in order, and a source reaches access_requested only after every channel was tried", async () => {
  const tried: string[] = [];
  const v = await escalateFetch("https://agency.gov/rule", {
    source: { rss_feed_url: "https://agency.gov/feed.xml", sitemap_url: "https://agency.gov/sitemap.xml" },
    directFetch: async () => (tried.push("direct"), wall()),
    feedFetch: async () => (tried.push("feed"), wall(429)),
    sitemapProbe: async () => (tried.push("sitemap"), { status: 200, listed: true }),
    browserFetch: async () => (tried.push("browser"), wall()),
    substituteFetch: async () => (tried.push("substitute"), []),
    contactOf: async () => ({ contact: "webmaster@agency.gov", rule: null }),
  });
  assert.deepEqual(tried, ["direct", "feed", "sitemap", "browser", "substitute"]);
  assert.equal(v.outcome, "access_requested");
  assert.equal(v.access?.contact, "webmaster@agency.gov");
  assert.deepEqual(v.attempts.map((a) => a.transport), ["direct", "feed", "sitemap", "browser"]);
  assert.equal(v.attempts.find((a) => a.transport === "sitemap")?.verdict, "discovery");
});
test("the browser tier unavailable is not exhaustion: the ladder defers and requests nothing of the publisher", async () => {
  const v = await escalateFetch("https://agency.gov/rule", { directFetch: async () => wall(), browserFetch: async () => ({ status: 0, text: "", truncated: false, fullLength: 0, cap: 0, needsHeadless: true }) });
  assert.equal(v.outcome, "deferred");
  assert.equal(v.holdReason, "NEEDS_BROWSER");
  assert.equal(v.attempts[1]?.class, NEEDS_HEADLESS);
});
test("a robots refusal skips the browser tier (it honours the same rule), tries the substitute, and the access request carries the rule; a robots.txt that cannot be read defers", async () => {
  let browser = 0;
  const v = await escalateFetch("https://agency.gov/rule", { directFetch: async () => policy("robots_disallowed", "robots.txt of agency.gov disallows /rule (Disallow: /)"), browserFetch: async () => (browser++, ok()), substituteFetch: async () => [], contactOf: async () => ({ contact: null, rule: null }) });
  assert.equal(browser, 0);
  assert.equal(v.outcome, "access_requested");
  assert.equal(v.access?.rule, "Disallow: /");
  assert.equal(v.access?.contact, null);
  assert.match(v.attempts.find((a) => a.transport === "browser")?.detail ?? "", /not run/);
  const unknown = await escalateFetch("https://agency.gov/rule", { directFetch: async () => policy("robots_unknown"), browserFetch: async () => ok() });
  assert.equal(unknown.outcome, "content", "an unreadable robots.txt on the direct channel does not stop the browser tier from asking its own gate");
  const stuck = await escalateFetch("https://agency.gov/rule", { directFetch: async () => policy("robots_unknown"), browserFetch: async () => policy("robots_unknown") });
  assert.equal(stuck.outcome, "deferred");
});
test("a not-found is not a wall: the browser tier is not asked, and nothing is requested of the publisher", async () => {
  let browser = 0;
  const v = await escalateFetch("https://agency.gov/gone", { directFetch: async () => ({ status: 404, text: "", truncated: false, fullLength: 0, cap: 0 }), browserFetch: async () => (browser++, ok()) });
  assert.equal(browser, 0);
  assert.equal(v.outcome, "seek_more");
});

// ---- the browser tier -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function fakeBrowser(script: (url: string) => { status: number; html: string | string[] }) {
  const log = { launches: 0, gotos: [] as Array<{ url: string; waitUntil: string }>, clicks: 0, closed: 0 };
  const browser: BrowserLike = {
    newContext: async () => ({
      newPage: async () => {
        let cur = "";
        let n = 0;
        return {
          goto: async (u: string, o: { waitUntil: "networkidle"; timeout: number }) => (log.gotos.push({ url: u, waitUntil: o.waitUntil }), (cur = u), (n = 0), { status: () => script(u).status }),
          content: async () => {
            const h = script(cur).html;
            return Array.isArray(h) ? (h[Math.min(n++, h.length - 1)] as string) : h;
          },
          url: () => cur,
          waitForTimeout: async () => undefined,
          close: async () => undefined,
          click: async () => void log.clicks++,
        };
      },
      close: async () => undefined,
    }),
    close: async () => void log.closed++,
  };
  return { log, launch: async () => (log.launches++, browser) };
}
const bdeps = (over: Partial<BrowserDeps> & { robots?: Record<string, { status: number; body?: string }> } = {}): { deps: BrowserDeps; sleeps: number[]; net: ReturnType<typeof routed> } => {
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const net = routed(async () => new Response("x"), over.robots ?? {});
  const rest = { ...over };
  delete rest.robots;
  const { db } = memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }] });
  return { net, sleeps, deps: { db, env: {}, fetchImpl: net.fetch, resolveHost: publicHost, now: () => new Date(clock), sleep: async (ms) => void (sleeps.push(ms), (clock += ms)), random: () => 0, ...rest } };
};

test("browser tier: it reads the rendered page once the network is idle and the content has stopped changing, with no click and no identity override", async () => {
  const fb = fakeBrowser(() => ({ status: 200, html: ["<html><body>loading</body></html>", `<html><body><p>${prose(20)}</p></body></html>`, `<html><body><p>${prose(20)}</p></body></html>`] }));
  const { deps } = bdeps({ launchBrowser: fb.launch });
  const r = await fetchBrowser("https://agency.gov/rule", deps, { max: 1_000_000 });
  assert.equal(r.status, 200);
  assert.ok(r.text.length > 1000, "the settled DOM, not the first parse");
  assert.equal(r.channel, "browser");
  assert.deepEqual(fb.log.gotos.map((g) => g.waitUntil), ["networkidle"]);
  assert.equal(fb.log.clicks, 0);
  await closeBrowser(deps);
  assert.equal(fb.log.closed, 1);
});
test("browser tier condition (a): it never runs on a URL robots.txt disallows or cannot read", async () => {
  const fb = fakeBrowser(() => ({ status: 200, html: `<p>${prose(20)}</p>` }));
  const dis = bdeps({ launchBrowser: fb.launch, robots: { "agency.gov": { status: 200, body: "User-agent: *\nDisallow: /rule\n" } } });
  const a = await fetchBrowser("https://agency.gov/rule/1", dis.deps, { max: 1_000_000 });
  assert.equal(a.refusal?.reason, "robots_disallowed");
  assert.equal(fb.log.gotos.length, 0, "no navigation");
  const unk = bdeps({ launchBrowser: fb.launch, robots: { "walled.gov": { status: 503 } } });
  const b = await fetchBrowser("https://walled.gov/x", unk.deps, { max: 1_000_000 });
  assert.equal(b.refusal?.reason, "robots_unknown");
  assert.equal(fb.log.gotos.length, 0);
  const none = bdeps({ launchBrowser: fb.launch });
  assert.equal((await fetchBrowser("https://agency.gov/rule", none.deps, { max: 1_000_000 })).status, 200, "no robots.txt: allowed");
});
test("browser tier: a host that refused the declared identity robots.txt has it re-read as a person's browser would, and its rules then apply", async () => {
  const pages: Record<string, { status: number; html: string }> = { "https://walled.gov/robots.txt": { status: 200, html: "<pre>User-agent: *\nDisallow: /secret</pre>" }, "https://walled.gov/open": { status: 200, html: `<p>${prose(20)}</p>` } };
  const fb = fakeBrowser((u) => pages[u] ?? { status: 404, html: "" });
  const { deps } = bdeps({ launchBrowser: fb.launch, robots: { "walled.gov": { status: 403 } } });
  const open = await fetchBrowser("https://walled.gov/open", deps, { max: 1_000_000 });
  assert.equal(open.status, 200);
  const secret = await fetchBrowser("https://walled.gov/secret", deps, { max: 1_000_000 });
  assert.equal(secret.refusal?.reason, "robots_disallowed");
  assert.ok(fb.log.gotos.some((g) => g.url === "https://walled.gov/robots.txt"));
});
test("browser tier condition (b): it never runs on a paywalled source and refuses a login or paywall gate", async () => {
  const fb = fakeBrowser(() => ({ status: 200, html: "<p>Please sign in to continue reading this article. Subscribers only.</p>" }));
  const { deps } = bdeps({ launchBrowser: fb.launch });
  const paid = await fetchBrowser("https://agency.gov/a", deps, { max: 1_000_000, paywalled: true });
  assert.equal(paid.refusal?.reason, "paywalled");
  assert.equal(fb.log.launches, 0, "not even started");
  const gated = await fetchBrowser("https://agency.gov/b", deps, { max: 1_000_000 });
  assert.equal(gated.refusal?.reason, "gated");
  assert.equal(gated.text, "");
});
test("browser tier condition (c): a CAPTCHA is recorded as an interactive challenge and never solved, clicked through or waited out", async () => {
  const fb = fakeBrowser(() => ({ status: 200, html: '<html><body><div class="g-recaptcha" data-sitekey="k"></div><p>Please verify you are human to continue.</p></body></html>' }));
  const { deps, sleeps } = bdeps({ launchBrowser: fb.launch });
  const r = await fetchBrowser("https://agency.gov/rule", deps, { max: 1_000_000 });
  assert.equal(r.refusal?.reason, "interactive_challenge");
  assert.equal(r.text, "");
  assert.equal(fb.log.clicks, 0, "nothing was clicked");
  assert.equal(fb.log.gotos.length, 1, "the page was loaded once and not reloaded in hope");
  assert.ok(sleeps.every((s) => s < 3000), "no wait for the challenge to clear");
});
test("browser tier condition (d): one navigation per host every 3 to 5 seconds, serialised per host; another host does not wait", async () => {
  const fb = fakeBrowser(() => ({ status: 200, html: `<p>${prose(20)}</p>` }));
  const { deps, sleeps } = bdeps({ launchBrowser: fb.launch, random: () => 0.5 });
  await Promise.all([fetchBrowser("https://agency.gov/1", deps, { max: 1_000_000 }), fetchBrowser("https://agency.gov/2", deps, { max: 1_000_000 }), fetchBrowser("https://agency.gov/3", deps, { max: 1_000_000 })]);
  const gaps = sleeps.filter((s) => s >= 3000);
  assert.equal(gaps.length, 2, "the second and third navigations to the host waited");
  assert.ok(gaps.every((g) => g >= 3000 && g <= 5000), `gaps ${gaps}`);
  const before = sleeps.length;
  await fetchBrowser("https://other.gov/1", deps, { max: 1_000_000 });
  assert.equal(sleeps.slice(before).filter((s) => s >= 3000).length, 0, "a different host starts at once");
});
test("browser tier off the runner returns needsHeadless and never crashes; a broken launch is reported as broken, not as absent", async () => {
  const { deps } = bdeps();
  const local = await fetchBrowser("https://agency.gov/rule", deps, { max: 1_000_000 });
  assert.equal(local.needsHeadless, true);
  const broken = bdeps({ launchBrowser: async () => { throw new Error("chromium crashed on start"); } });
  const b = await fetchBrowser("https://agency.gov/rule", broken.deps, { max: 1_000_000 });
  assert.equal(b.refusal?.reason, "browser_launch_failed");
  assert.match(b.refusal?.detail ?? "", /crashed on start/);
  const missing = bdeps({ launchBrowser: async () => { throw new Error("Executable doesn't exist at /x/chrome"); } });
  assert.equal((await fetchBrowser("https://agency.gov/rule", missing.deps, { max: 1_000_000 })).needsHeadless, true);
});

// ---- the substitute table and the runner side ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test("identifiers are read only where the evidence is explicit", () => {
  assert.deepEqual(identifiersOf("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1115").map((i) => [i.scheme, i.id]), [["celex", "32023R1115"]]);
  assert.deepEqual(identifiersOf("https://x.gov/y", "S.I. 2023/456").map((i) => [i.scheme, i.id]), [["uk_legislation", "uksi/2023/456"]]);
  assert.deepEqual(identifiersOf("https://www.legislation.gov.uk/ukpga/2008/27/contents").map((i) => i.id), ["ukpga/2008/27"]);
  assert.deepEqual(identifiersOf("https://x.gov/y", "Public Law 117-58 and 40 CFR Part 98").map((i) => i.scheme).sort(), ["cfr", "public_law"]);
  assert.deepEqual(identifiersOf("https://x.gov/some-page"), []);
});
test("the substitute table: an unverified entry is never used, a credential-needing channel self-skips without its variable, the refusing host is never its own substitute", () => {
  const ids = identifiersOf("https://x.gov/y", "CELEX 32023R1115 and EPA-HQ-OAR-2021-0208-0001 and MEPC.376(80)");
  const none = substituteCandidates(ids, { env: {}, today: "2026-10-19" });
  assert.deepEqual(none.use.map((c) => c.entry.id), ["cellar"]);
  assert.equal(none.use[0]?.url, "https://publications.europa.eu/resource/celex/32023R1115");
  assert.ok(none.skipped.some((s) => s.publisher === "regulations_gov_api" && /REGULATIONS_GOV_API_KEY/.test(s.why) && /free: true/.test(s.why)));
  assert.ok(none.skipped.some((s) => s.publisher === "mca" && /unverified/.test(s.why)));
  assert.ok(none.skipped.some((s) => s.publisher === "eur_lex_ws" && /unverified/.test(s.why)));
  const keyed = substituteCandidates(ids, { env: { REGULATIONS_GOV_API_KEY: "k e y" }, today: "2026-10-19" });
  assert.ok(keyed.use.some((c) => c.entry.id === "regulations_gov_api" && c.url === "https://api.regulations.gov/v4/documents/EPA-HQ-OAR-2021-0208-0001?api_key=k%20e%20y"));
  const self = substituteCandidates(ids, { env: {}, today: "2026-10-19", refusingHost: "publications.europa.eu" });
  assert.equal(self.use.length, 0);
  assert.ok(credentialGaps().some((g) => g.publisher === "regulations_gov_api" && g.free && g.registration.startsWith("https://")));
});

function world(over: { sourceUrl?: string; paywalled?: boolean; identifier?: string | null; robots?: Record<string, { status: number; body?: string }>; handler?: (u: string) => Response } = {}) {
  const url = over.sourceUrl ?? "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1115";
  const m = memoryDb({
    system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }],
    sources: [{ id: "src-1", url, name: "EUR-Lex", base_tier: 1, tier_override: null, status: "active", paywalled: over.paywalled ?? false, access_method: "scrape", institution_key: null }],
    intelligence_items: [{ id: "item-1", source_id: "src-1", is_archived: false, instrument_identifier: over.identifier ?? null }],
    pending_first_fetch: [{ id: "q-1", source_id: "src-1", status: "refused", attempt_count: 1, queued_at: "2026-10-18T00:00:00Z" }],
  });
  const net = routed(over.handler ?? (() => new Response("denied", { status: 403 })), over.robots ?? {});
  const fb = fakeBrowser(() => ({ status: 403, html: "<html><body>Access Denied. Reference #18.1234</body></html>" }));
  const sleeps: number[] = [];
  const deps = { db: m.db, now: () => new Date("2026-10-19T12:00:00Z"), env: { GITHUB_ACTIONS: "true" } as Record<string, string | undefined>, fetchImpl: net.fetch, resolveHost: publicHost, sleep: async (ms: number) => void sleeps.push(ms), launchBrowser: fb.launch, random: () => 0 };
  return { m, net, fb, deps, sleeps };
}
const cellarXhtml = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Regulation (EU) 2023/1115</title></head><body><p>Article 1 Subject matter. ${prose(30)}</p></body></html>`;

test("INV-R2c-5: a CELEX fixture refused at its first publisher is captured from the second, and the capture belongs to the second publisher's registry row", async () => {
  const w = world({ handler: (u) => (u.startsWith("https://publications.europa.eu/resource/celex/") ? new Response(cellarXhtml, { headers: { "content-type": "application/xhtml+xml" } }) : new Response("denied", { status: 403 })) });
  const r = await collectRefused(w.deps, { limit: 1 });
  assert.deepEqual([r.counts.substituted, r.counts.served, r.counts.access_requested, r.counts.failed], [1, 0, 0, 0], r.notes.join("; "));
  const cellar = w.m.tables.sources?.find((s) => String(s.url).startsWith("https://publications.europa.eu/"));
  assert.ok(cellar, "the second publisher is a registry row");
  assert.equal(cellar?.base_tier, 2, "rated by the class table, not by the refusing source");
  const run = w.m.tables.agent_runs?.[0];
  assert.equal(run?.source_id, cellar?.id, "source_id is the second publisher's row");
  assert.notEqual(run?.source_id, "src-1");
  const cap = w.m.tables.agent_run_searches?.[0];
  assert.equal(cap?.capture_channel, "substitute");
  assert.match(String(cap?.result_url), /^https:\/\/publications\.europa\.eu\//);
  const src = w.m.tables.sources?.find((s) => s.id === "src-1");
  assert.equal(src?.collection_state, "served");
  assert.equal((src?.collection_detail as { substitute_publisher?: string }).substitute_publisher, "publications.europa.eu");
  assert.equal(w.m.tables.pending_first_fetch?.[0]?.status, "done");
  const channels = (src?.collection_detail as { attempts: Array<{ channel: string }> }).attempts.map((a) => a.channel);
  assert.deepEqual(channels, ["browser", "substitute"], "the exhaustion record names the channels tried here");
  assert.equal(w.fb.log.clicks, 0);
});
test("a source nothing serves reaches access_requested with the contact the publisher publishes, a date, and no archive or proxy ever asked", async () => {
  const w = world({ sourceUrl: "https://agency.gov/some-page", robots: { "agency.gov": { status: 200, body: "# access arrangements: data@agency.gov\nUser-agent: *\nAllow: /\n" } } });
  const r = await collectRefused(w.deps, { limit: 1 });
  assert.equal(r.counts.access_requested, 1, r.notes.join("; "));
  const src = w.m.tables.sources?.[0];
  assert.equal(src?.collection_state, "access_requested");
  assert.equal(src?.access_contact, "data@agency.gov");
  assert.match(String(src?.access_requested_at), /^2026-10-19/);
  assert.equal(w.m.tables.pending_first_fetch?.[0]?.status, "skipped");
  assert.equal(w.m.tables.agent_run_searches, undefined);
  assert.ok(!w.net.calls.some((u) => /archive\.org|web\.archive/.test(u)));
  const nobody = world({ sourceUrl: "https://agency.gov/some-page" });
  await collectRefused(nobody.deps, { limit: 1 });
  assert.equal(nobody.m.tables.sources?.[0]?.access_contact, null, "null when the publisher publishes none");
});
test("a paywalled row is never read by the browser tier, and a robots-disallowed source is requested with the rule, not browsed", async () => {
  const paid = world({ sourceUrl: "https://agency.gov/some-page", paywalled: true });
  await collectRefused(paid.deps, { limit: 1 });
  assert.equal(paid.fb.log.gotos.length, 0);
  const dis = world({ sourceUrl: "https://agency.gov/some-page", robots: { "agency.gov": { status: 200, body: "User-agent: *\nDisallow: /\n" } } });
  const r = await collectRefused(dis.deps, { limit: 1 });
  assert.equal(dis.fb.log.gotos.length, 0);
  assert.equal(r.counts.access_requested, 1);
  assert.match(JSON.stringify(dis.m.tables.sources?.[0]?.collection_detail), /Disallow: \//);
});
test("off the runner nothing is concluded: the refused row stays refused for the runner, counted as deferred", async () => {
  const w = world({ sourceUrl: "https://agency.gov/some-page" });
  const local: Record<string, unknown> = { ...w.deps, env: {} };
  delete local.launchBrowser;
  const r = await collectRefused(local as unknown as typeof w.deps, { limit: 1 });
  assert.equal(r.counts.deferred, 1);
  assert.equal(w.m.tables.pending_first_fetch?.[0]?.status, "refused");
  assert.notEqual(w.m.tables.sources?.[0]?.collection_state, "access_requested");
});
test("collectRefused is dry-aware and honours the fetch gate", async () => {
  const w = world();
  const dry = await collectRefused(w.deps, { dry: true });
  assert.equal(dry.counts.refused, 1);
  assert.equal(w.net.calls.length + w.fb.log.gotos.length, 0);
  w.m.tables.system_state![0]!.scrape_cadence = "off";
  const closed = await collectRefused(w.deps, { limit: 1 });
  assert.equal(closed.outcome, "failed");
  assert.equal(w.m.tables.pending_first_fetch?.[0]?.status, "refused");
});
