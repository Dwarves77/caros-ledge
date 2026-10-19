// The walkers (sitemap, feed, portal links, register), the candidate and title resolvers, the polite capture, and the cache.
import assert from "node:assert/strict";
import { test } from "node:test";

import { apiEndpointFor } from "@/core/fetch/api";
import { capture, makePoliteGate, parseOjReference } from "@/core/fetch/capture";
import { buildTitleForRow, detectNotInForce, extractTitleFromHtml } from "@/core/fetch/titles";
import { extractPortalLinks } from "@/features/sources/walkers/portal-links";
import { type SitemapUrlEntry } from "@/features/sources/walkers/sitemap";
import { euCandidates, fetchPrimaryWithFallback, generateCandidates } from "@/core/fetch/candidates";
import { discoveredFeedLinks, feedCandidateUrls, isFeedDocument, walkFeed } from "@/features/sources/walkers/feed";
import { walkFederalRegister } from "@/features/sources/walkers/register";

import { instant, routed } from "../_support/net.ts";
import { memoryDb } from "../_support/memory-db.ts";
import { walkSitemap } from "../_support/sitemap.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);

function sitemapWorld(files: Record<string, string>, previous: SitemapUrlEntry[] | null = null) {
  const saved: SitemapUrlEntry[][] = [];
  const persisted: string[] = [];
  return {
    saved,
    persisted,
    deps: {
      fetchBytes: async (url: string) => {
        if (url in files) return bytes(files[url] as string);
        throw new Error(`HTTP 404 for ${url}`);
      },
      getPreviousSnapshot: async () => previous,
      saveSnapshot: async (e: SitemapUrlEntry[]) => void saved.push(e),
      persist: async (links: Array<{ url: string }>) => (persisted.push(...links.map((l) => l.url)), { upserted: links.length, failed: 0 }),
      recordChange: async () => undefined,
    },
  };
}
test("walkSitemap: robots discovery fans out through an index, a complete walk writes its baseline and hands the new locs to the ledger write", async () => {
  const w = sitemapWorld({
    "https://a.gov/robots.txt": "Sitemap: https://a.gov/index.xml",
    "https://a.gov/index.xml": "<sitemapindex><sitemap><loc>https://a.gov/s1.xml</loc></sitemap></sitemapindex>",
    "https://a.gov/s1.xml": "<urlset><url><loc>https://a.gov/p1</loc></url><url><loc>https://a.gov/p2</loc></url></urlset>",
  });
  const out = await walkSitemap(w.deps, { baseUrl: "https://a.gov/" });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.discoverySource, "robots");
    assert.equal(out.urlCount, 2);
    assert.equal(out.coverageComplete, true);
    assert.equal(out.diff.addedCount, 2);
  }
  assert.deepEqual(w.persisted, ["https://a.gov/p1", "https://a.gov/p2"]);
  assert.equal(w.saved.length, 1);
});
test("walkSitemap: a failed child makes coverage incomplete, so nothing is called removed and no baseline is claimed", async () => {
  const w = sitemapWorld(
    {
      "https://a.gov/robots.txt": "Sitemap: https://a.gov/ok.xml\nSitemap: https://a.gov/broken.xml",
      "https://a.gov/ok.xml": "<urlset><url><loc>https://a.gov/p1</loc></url></urlset>",
    },
    [{ loc: "https://a.gov/was-here", lastmod: null, changefreq: null }, { loc: "https://a.gov/p1", lastmod: null, changefreq: null }],
  );
  const out = await walkSitemap(w.deps, { baseUrl: "https://a.gov/" });
  assert.equal(out.ok && out.coverageComplete, false);
  assert.equal(out.ok && out.diff.removedCount, 0);
  assert.equal(out.ok && out.removedSuppressed, true);
  assert.ok(w.saved[0]?.some((e) => e.loc === "https://a.gov/was-here"), "a partial walk merges rather than dropping what it did not see");
  const first = sitemapWorld({ "https://a.gov/robots.txt": "Sitemap: https://a.gov/broken.xml" });
  const res = await walkSitemap(first.deps, { baseUrl: "https://a.gov/" });
  assert.equal(res.ok && res.baselineDeferred, true);
  assert.equal(first.saved.length, 0);
});
test("walkSitemap: a bot wall everywhere is named as one, and no sitemap at all is a failure that says why", async () => {
  const walled = sitemapWorld({});
  walled.deps.fetchBytes = async (url: string) => {
    throw new Error(`HTTP 403 for ${url}`);
  };
  const out = await walkSitemap(walled.deps, { baseUrl: "https://a.gov/" });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.discoverySource, "bot_wall");
  const none = await walkSitemap(sitemapWorld({}).deps, { baseUrl: "https://a.gov/" });
  assert.match(!none.ok ? none.error : "", /no sitemap discovered/);
  const shell = sitemapWorld({ "https://a.gov/robots.txt": "", "https://a.gov/sitemap.xml": `<html><body>Just a moment... Checking your browser</body></html>` });
  const sh = await walkSitemap(shell.deps, { baseUrl: "https://a.gov/" });
  assert.match(!sh.ok ? sh.error : "", /bot_wall/, "a 200 challenge page in place of a sitemap is named");
});
test("walkSitemap: the entry budget binds loudly", async () => {
  const w = sitemapWorld({
    "https://a.gov/robots.txt": "Sitemap: https://a.gov/s1.xml\nSitemap: https://a.gov/s2.xml",
    "https://a.gov/s1.xml": "<urlset><url><loc>https://a.gov/p1</loc></url><url><loc>https://a.gov/p2</loc></url></urlset>",
    "https://a.gov/s2.xml": "<urlset><url><loc>https://a.gov/p3</loc></url></urlset>",
  });
  const out = await walkSitemap(w.deps, { baseUrl: "https://a.gov/", maxSitemapEntries: 2 });
  assert.equal(out.ok && out.entriesCapped, true);
  assert.equal(out.ok && out.coverageComplete, false);
});

test("portal links: same-site links only, resolved against the portal, fragments dropped", () => {
  const links = extractPortalLinks(`<a href="/rules/1">Rule one</a><a href="https://other.com/x">Other</a><a href="#top">top</a>`, "https://a.gov/");
  assert.deepEqual(links, [{ url: "https://a.gov/rules/1", anchorText: "Rule one" }]);
});

test("titles: a captured title is used, a not-in-force banner is detected from the text", () => {
  assert.deepEqual(extractTitleFromHtml("<html><head><title>Regulation (EU) 2023/956 - EUR-Lex</title></head></html>"), { title: "Regulation (EU) 2023/956 - EUR-Lex", origin: "captured_title" });
  assert.equal(extractTitleFromHtml("<html></html>"), null);
  assert.ok(buildTitleForRow({ capture: { html: "<title>A Real Title</title>", text: prose(5) }, source: { name: "Src" } as never, identifier: "2023/956" } as never));
  assert.equal(detectNotInForce("A plain statute text with no banner."), null);
});

test("api: an API host resolves to its endpoint base, any other host to none", () => {
  assert.equal(apiEndpointFor("https://www.federalregister.gov/documents/2024/01/01/2024-00001/x"), "https://www.federalregister.gov/api/v1");
  assert.equal(apiEndpointFor("https://example.com/x"), null);
});

// capture
test("capture: parseOjReference reads the series, year and issue; the polite gate spaces hits per host", async () => {
  assert.deepEqual(parseOjReference("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202301234"), { series: "L", year: "2023", issue: "01234", edition: null });
  assert.equal(parseOjReference("https://example.com/"), null);
  let t = 0;
  const slept: number[] = [];
  const gate = makePoliteGate({ now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) });
  await gate("a.gov");
  await gate("a.gov");
  assert.deepEqual(slept, [1000]);
});
test("capture: a generic capture goes through the hold gate and returns the cited url; a wall is held, never stored", async () => {
  const w = memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }] });
  const ok = await capture("https://a.gov/p", { family: "generic" }, { db: w.db, env: {}, sleep: instant, fetchImpl: routed(async () => new Response(`<html><title>Doc</title><body>${prose(40)}</body></html>`, { headers: { "content-type": "text/html" } })).fetch });
  assert.equal(ok.usable, true);
  assert.equal(ok.transport, "direct");
  assert.equal(ok.holdReason, null);
  const walled = await capture("https://a.gov/p", { family: "generic" }, { db: w.db, env: {}, sleep: instant, fetchImpl: routed(async () => new Response("Just a moment...", { status: 403 })).fetch });
  assert.equal(walled.usable, false);
  assert.equal(walled.text, null);
  assert.match(walled.holdReason ?? "", /^capture_blocked$/, "no archive suffix: no archive is ever read");
  const off = memoryDb({ system_state: [{ id: true, scrape_cadence: "off", global_processing_paused: false }] });
  await assert.rejects(() => capture("https://a.gov/p", { family: "generic" }, { db: off.db, env: {}, fetchImpl: (async () => new Response("x")) as typeof fetch }), /FETCH_HOLD_ENGAGED/);
});

test("feed: documents are recognised, candidate urls scoped, and a walk persists what it found", async () => {
  assert.equal(isFeedDocument("<?xml version='1.0'?><rss version='2.0'>"), true);
  assert.equal(isFeedDocument("<html>"), false);
  const xml = `<rss><channel><item><title>T</title><link>https://a.gov/1</link><pubDate>Mon, 01 Jan 2026</pubDate></item></channel></rss>`;
  assert.deepEqual(discoveredFeedLinks(`<link rel="alternate" type="application/rss+xml" href="/f.xml">`, "https://a.gov/"), ["https://a.gov/f.xml"]);
  assert.ok(feedCandidateUrls("https://a.gov/").includes("https://a.gov/feed"));
  const persisted: string[] = [];
  const out = await walkFeed({ fetchText: async () => xml, persist: async (l) => (persisted.push(...l.map((x) => x.url)), { upserted: l.length, failed: 0 }) }, { feedUrl: "https://a.gov/f.xml" });
  assert.equal(out.ok, true);
  assert.deepEqual(persisted, ["https://a.gov/1"]);
});
test("the Federal Register walk persists the documents the API lists and skips one with no url", async () => {
  const persisted: string[] = [];
  const out = await walkFederalRegister(
    { fetchJson: async () => ({ count: 2, total_pages: 1, next_page_url: null, results: [{ html_url: "https://www.federalregister.gov/d/1", title: "A rule" }, { title: "no url" }] as never }), persist: async (l) => (persisted.push(...l.map((x) => x.url)), { upserted: l.length, failed: 0 }) },
    { from: "2026-01-01", to: "2026-01-31" } as never,
  );
  assert.ok(out);
  assert.deepEqual(persisted, ["https://www.federalregister.gov/d/1"]);
});
test("candidates: identifiers resolve to canonical URLs first, a web search is last and optional, and https only", async () => {
  assert.deepEqual(euCandidates({ identifier: "2023/956", itemType: "regulation" }).celex, ["32023R0956"]);
  const list = await generateCandidates({ identifier: "2023/956", jurisdiction: "EU", title: "CBAM" }, { webSearch: async () => ["https://example.org/cbam", "http://insecure.example/x"] });
  assert.equal(list[0]?.startsWith("https://eur-lex.europa.eu/"), true);
  assert.equal(list.at(-1), "https://example.org/cbam");
  assert.equal(list.some((u) => u.startsWith("http://")), false, "https only");
  assert.deepEqual(await generateCandidates({}, {}), []);
  assert.equal((await generateCandidates({ identifier: "2023/956", jurisdiction: "EU" }, { webSearch: async () => { throw new Error("down"); } })).length > 0, true, "a failed search leaves the deterministic candidates");
});
test("fallback: a roadblocked primary tries a bounded set of alternatives and records every attempt; a clean primary never searches", async () => {
  const seen: string[] = [];
  const out = await fetchPrimaryWithFallback(
    { primaryUrl: "https://a.gov/p" },
    { fetchText: async (u) => (seen.push(u), u === "https://alt.gov/ok" ? { text: prose(40), status: 200 } : { text: "Just a moment...", status: 403 }), discoverCandidates: () => ["https://alt.gov/bad", "https://alt.gov/ok", "https://alt.gov/never"], perFetchMs: 1000 },
  );
  assert.equal(out.ok, true);
  assert.equal(out.fellBack, true);
  assert.equal(out.url, "https://alt.gov/ok");
  assert.deepEqual(out.alternatives.map((a) => a.role), ["declared_primary", "alternative", "alternative"]);
  assert.equal(seen.includes("https://alt.gov/never"), false);
  let searched = 0;
  const clean = await fetchPrimaryWithFallback({ primaryUrl: "https://a.gov/p" }, { fetchText: async () => ({ text: prose(40) }), discoverCandidates: () => (searched++, []) });
  assert.equal(clean.fellBack, false);
  assert.equal(searched, 0);
  const none = await fetchPrimaryWithFallback({ primaryUrl: "https://a.gov/p" }, { fetchText: async () => ({ text: "", status: 404 }), discoverCandidates: () => ["https://alt.gov/x"] });
  assert.equal(none.ok, false);
});
