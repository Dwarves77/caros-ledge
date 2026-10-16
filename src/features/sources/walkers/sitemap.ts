// Ported from old_repo/src/lib/sources/sitemap-walk.mjs (lines 1-623)
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { detectAccessWall } from "@/core/fetch/classify-body";
import { hostOf } from "@/core/shared";

import { discoveredFeedLinks, feedCandidateUrls, isFeedDocument } from "./feed";
import { inner } from "./xml";

export interface SitemapUrlEntry {
  loc: string;
  lastmod: string | null;
  changefreq?: string | null;
}
export interface SitemapIndexEntry {
  loc: string;
  lastmod: string | null;
}
const safePath = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

/** A status that suggests a bot wall (Cloudflare, Akamai, ...). The content-based detector covers the 200-OK shells this cannot see. */
export const isBotWallStatus = (status: number | null): boolean => status === 401 || status === 403 || status === 429;
/** `Sitemap:` lines of a robots.txt body (any case); relative values resolve against `baseUrl`; only absolute https URLs are kept, a malformed value is skipped. */
export function parseRobotsSitemapLines(robotsTxt: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const line of String(robotsTxt ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S.*?)\s*$/i);
    if (!m?.[1]) continue;
    try {
      const u = new URL(m[1], baseUrl);
      if (u.protocol === "https:") out.push(u.toString());
    } catch {
      // a malformed directive value: skip, never throw
    }
  }
  return out;
}
export function sitemapFallbackCandidates(baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`];
}
/** The path a source is scoped to, or "" for a bare origin or a syndication endpoint (scoping those would scope nothing meaningful). */
export function sourceContentPath(sourceUrl: string): string {
  const pathname = new URL(sourceUrl).pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  return pathname === "/" || /\.(?:xml|rss|atom|json|gz)$/i.test(pathname) || /\/(?:feed|rss|atom)\/?$/i.test(pathname) ? "" : pathname;
}
/** Is `candidateUrl` within the source's scoped path (same host, path equal to or nested under the scope)? An unscoped source admits everything on its host. */
export function isUrlWithinSourcePath(candidateUrl: string, sourceUrl: string): boolean {
  const scope = sourceContentPath(sourceUrl);
  if (!scope) return true;
  try {
    if (hostOf(candidateUrl) !== hostOf(sourceUrl)) return false;
    const pathname = new URL(candidateUrl).pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    return pathname === scope || pathname.startsWith(`${scope}/`);
  } catch {
    return false;
  }
}
export const filterEntriesForSource = <T extends { loc: string }>(entries: T[], sourceUrl: string): T[] => (sourceContentPath(sourceUrl) ? entries.filter((e) => isUrlWithinSourcePath(e.loc, sourceUrl)) : entries);

export const looksGzippedUrl = (url: string): boolean => /\.gz(?:[?#].*)?$/i.test(String(url ?? ""));
export const looksGzippedBuffer = (buf: Uint8Array): boolean => buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
/** A fetched sitemap body to text, gunzipped when the URL or the magic bytes say so. */
export async function decodeXmlBody(buf: Uint8Array, url: string): Promise<string> {
  const b = Buffer.from(buf);
  return (looksGzippedUrl(url) || looksGzippedBuffer(b) ? await promisify(gunzip)(b) : b).toString("utf8");
}
export const DEFAULT_MAX_SITEMAP_RESPONSE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_FEED_RESPONSE_BYTES = 10_000_000;
export function checkResponseBytes(buf: Uint8Array, maxBytes: number, url: string): void {
  if (buf.length > maxBytes) throw new Error(`response for ${url} is ${buf.length.toLocaleString()} bytes, over the ${maxBytes.toLocaleString()}-byte bound`);
}

export const sitemapRootKind = (xml: string): "urlset" | "sitemapindex" | "unknown" => (/<sitemapindex[\s>]/i.test(xml) ? "sitemapindex" : /<urlset[\s>]/i.test(xml) ? "urlset" : "unknown");
const httpsEntries = (xml: string, tag: string): Array<{ loc: string; block: string }> =>
  (String(xml ?? "").match(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi")) ?? []).map((block) => ({ loc: inner(block, "loc") ?? "", block })).filter((e) => /^https:\/\//i.test(e.loc));
export const parseUrlsetEntries = (xml: string): SitemapUrlEntry[] => httpsEntries(xml, "url").map((e) => ({ loc: e.loc, lastmod: inner(e.block, "lastmod"), changefreq: inner(e.block, "changefreq") }));
export const parseSitemapIndexEntries = (xml: string): SitemapIndexEntry[] => httpsEntries(xml, "sitemap").map((e) => ({ loc: e.loc, lastmod: inner(e.block, "lastmod") }));
/** One sitemap document by its declared root; a malformed or foreign document is `unknown` with both lists empty, never a throw. */
export function parseSitemapXml(xml: string) {
  const kind = sitemapRootKind(xml);
  return { kind, urlEntries: kind === "urlset" ? parseUrlsetEntries(xml) : [], sitemapEntries: kind === "sitemapindex" ? parseSitemapIndexEntries(xml) : [] };
}
/** First-loc-wins dedupe. */
export function dedupeByLoc(entries: SitemapUrlEntry[]): SitemapUrlEntry[] {
  const seen = new Map<string, SitemapUrlEntry>();
  for (const e of entries) if (!seen.has(e.loc)) seen.set(e.loc, e);
  return [...seen.values()];
}
/** New locs, locs whose lastmod changed, locs that dropped out. `previous` null (a first walk) reports everything `added` and nothing `removed`. */
export function diffUrlSet(previous: SitemapUrlEntry[] | null, current: SitemapUrlEntry[]) {
  const prev = new Map((previous ?? []).map((e) => [e.loc, e]));
  const cur = new Set(current.map((e) => e.loc));
  const added: SitemapUrlEntry[] = [];
  const changed: Array<{ loc: string; previousLastmod: string | null; currentLastmod: string | null }> = [];
  for (const e of current) {
    const p = prev.get(e.loc);
    if (!p) added.push(e);
    else if ((p.lastmod ?? null) !== (e.lastmod ?? null)) changed.push({ loc: e.loc, previousLastmod: p.lastmod ?? null, currentLastmod: e.lastmod ?? null });
  }
  return { added, changed, removed: previous == null ? [] : previous.filter((e) => !cur.has(e.loc)) };
}
/** A partial walk merged into the prior snapshot: an unreached loc keeps its last-known lastmod; a seen one is overwritten. */
export const mergeSnapshotEntries = (previous: SitemapUrlEntry[] | null, current: SitemapUrlEntry[]): SitemapUrlEntry[] => [...new Map([...(previous ?? []), ...current].map((e) => [e.loc, e])).values()];

export const DEFAULT_MAX_SITEMAP_FETCHES = 50;
export const DEFAULT_MAX_SITEMAP_ENTRIES = 100_000;
const httpStatusOf = (msg: string): number | null => {
  const m = String(msg ?? "").match(/HTTP (\d+)/);
  return m ? Number(m[1]) : null;
};

export interface SitemapDeps {
  fetchBytes: (url: string) => Promise<Uint8Array>;
  getPreviousSnapshot: () => Promise<SitemapUrlEntry[] | null>;
  saveSnapshot: (entries: SitemapUrlEntry[]) => Promise<void>;
  persist: (links: Array<{ url: string; anchorText?: string | null }>) => Promise<{ upserted: number; failed: number }>;
  recordChange: (changed: Array<{ loc: string; previousLastmod: string | null; currentLastmod: string | null }>) => Promise<void>;
}
interface Fetched {
  url: string;
  kind: string;
  urlCount: number;
  childCount: number;
  error: string | null;
  wall: { kind: string; evidence: string } | null;
}
export interface SitemapOpts {
  baseUrl: string;
  maxSitemapFetches?: number;
  maxSitemapEntries?: number;
  maxSitemapResponseBytes?: number;
  limit?: number;
}

/**
 * Walk one source's sitemap: discover (robots.txt, else the fallback candidates), fan out through any index within a document budget AND an entry budget, dedupe, scope to the
 * source's own path, diff against the previous snapshot, report new, changed and removed, and hand the new locs to the injected ledger write. A per-sitemap failure is recorded and the walk
 * continues; `ok: false` only when no sitemap could be discovered at all. `coverageComplete` gates every claim that depends on having seen everything (removed, the baseline).
 */
export async function walkSitemap(deps: SitemapDeps, { baseUrl, maxSitemapFetches = DEFAULT_MAX_SITEMAP_FETCHES, maxSitemapEntries = DEFAULT_MAX_SITEMAP_ENTRIES, maxSitemapResponseBytes = DEFAULT_MAX_SITEMAP_RESPONSE_BYTES, limit = Infinity }: SitemapOpts) {
  const fetched: Fetched[] = [];
  const cache = new Map<string, ReturnType<typeof parseSitemapXml> | null>();
  async function fetchAndParse(url: string) {
    if (cache.has(url)) return cache.get(url) ?? null;
    let result: ReturnType<typeof parseSitemapXml> | null;
    try {
      const buf = await deps.fetchBytes(url);
      checkResponseBytes(buf, maxSitemapResponseBytes, url);
      const xml = await decodeXmlBody(buf, url);
      const parsed = parseSitemapXml(xml);
      // A 200-OK CAPTCHA, challenge or interface shell in place of a sitemap parses as unknown; the content-based detector names it (the status check cannot see it).
      const w = parsed.kind === "unknown" ? detectAccessWall(xml, { host: hostOf(url) || null, path: safePath(url) }) : null;
      fetched.push({ url, kind: parsed.kind, urlCount: parsed.urlEntries.length, childCount: parsed.sitemapEntries.length, error: null, wall: w ? { kind: w.class, evidence: w.evidence } : null });
      result = parsed;
    } catch (e) {
      fetched.push({ url, kind: "error", urlCount: 0, childCount: 0, error: (e as Error).message, wall: null });
      result = null;
    }
    cache.set(url, result);
    return result;
  }
  const fail = (error: string, discoverySource: string) => ({ ok: false as const, baseUrl, error, sitemapsFetched: fetched, robotsSitemapCount: 0, discoverySource, sitemapsSkippedCap: 0, entriesCapped: false });

  let robotsLines: string[] = [];
  let robotsError: string | null = null;
  let robotsStatus: number | null = null;
  try {
    const robotsBuf = await deps.fetchBytes(new URL("/robots.txt", baseUrl).toString());
    robotsStatus = 200;
    checkResponseBytes(robotsBuf, maxSitemapResponseBytes, "robots.txt");
    robotsLines = parseRobotsSitemapLines(await decodeXmlBody(robotsBuf, "robots.txt"), baseUrl);
  } catch (e) {
    robotsError = (e as Error).message;
    robotsStatus = httpStatusOf(robotsError);
  }
  let queue: string[] = [];
  let discoverySource = "none";
  if (robotsLines.length) {
    queue = [...new Set(robotsLines)];
    discoverySource = "robots";
  } else {
    for (const candidate of sitemapFallbackCandidates(baseUrl)) {
      const parsed = await fetchAndParse(candidate);
      if (parsed && parsed.kind !== "unknown") {
        queue = [candidate];
        discoverySource = "fallback";
        break;
      }
    }
  }
  const probes = fetched.filter((s) => s.url !== "robots.txt" && s.kind === "error");
  if (isBotWallStatus(robotsStatus) && sitemapFallbackCandidates(baseUrl).every((c) => probes.some((p) => p.url === c && isBotWallStatus(httpStatusOf(p.error ?? ""))))) {
    return fail(`bot_wall detected: homepage returned HTTP ${robotsStatus} and all fallback candidates answered 401/403/429`, "bot_wall");
  }
  if (!queue.length) {
    const walled = fetched.find((s) => s.wall);
    if (walled?.wall) return fail(`bot_wall detected: ${walled.url} returned a 200 OK ${walled.wall.kind} shell in place of a sitemap`, "bot_wall");
    return fail(`no sitemap discovered: robots.txt yielded 0 Sitemap: lines (${robotsError ?? "fetched, none declared"}) and none of the fallback candidates parsed as a sitemap`, discoverySource);
  }

  const raw: SitemapUrlEntry[] = [];
  let budget = maxSitemapFetches;
  let skippedCap = 0;
  let entriesCapped = false;
  const queued = new Set(queue);
  while (queue.length) {
    if (raw.length >= maxSitemapEntries) {
      entriesCapped = true;
      skippedCap += queue.length;
      break;
    }
    const url = queue.shift() as string;
    if (budget <= 0) {
      skippedCap++;
      continue;
    }
    budget--;
    const parsed = await fetchAndParse(url);
    if (!parsed) continue;
    if (parsed.kind === "urlset") raw.push(...parsed.urlEntries);
    else if (parsed.kind === "sitemapindex") {
      for (const child of parsed.sitemapEntries) {
        if (!queued.has(child.loc)) {
          queued.add(child.loc);
          queue.push(child.loc);
        }
      }
    }
  }
  const deduped = dedupeByLoc(raw);
  const scopedAll = filterEntriesForSource(deduped, baseUrl);
  const current = scopedAll.slice(0, limit);
  const urlsOverLimit = scopedAll.length - current.length;
  const coverageComplete = skippedCap === 0 && !entriesCapped && urlsOverLimit === 0 && fetched.every((s) => s.kind !== "error");
  const previous = await deps.getPreviousSnapshot();
  const diff = diffUrlSet(previous, current);
  const removedLocs = coverageComplete ? diff.removed.map((e) => e.loc) : [];
  const persistResult = await deps.persist(diff.added.map((e) => ({ url: e.loc, anchorText: e.lastmod ? `lastmod ${e.lastmod}` : null })));
  if (diff.changed.length) await deps.recordChange(diff.changed);
  // A baseline is written only on complete coverage; a partial walk merges, so a later complete walk is not misled into false "removed" or false "new".
  const baselineDeferred = previous == null && !coverageComplete;
  const nextSnapshot = previous == null ? (coverageComplete ? current : null) : coverageComplete ? current : mergeSnapshotEntries(previous, current);
  if (nextSnapshot) await deps.saveSnapshot(nextSnapshot);
  return {
    ok: true as const, baseUrl, sitemapsFetched: fetched, robotsSitemapCount: robotsLines.length, discoverySource, sitemapsSkippedCap: skippedCap, entriesCapped, maxSitemapEntries,
    scopedOutCount: deduped.length - scopedAll.length, urlCount: current.length, urlsOverLimit, coverageComplete, baselineDeferred,
    diff: { addedCount: diff.added.length, changedCount: diff.changed.length, removedCount: removedLocs.length },
    changedLocs: diff.changed, removedLocs, removedSuppressed: !coverageComplete && diff.removed.length > 0,
    upserted: persistResult.upserted, failed: persistResult.failed, changeRecorded: diff.changed.length > 0,
  };
}

/** Probe one candidate: fetch (bounded), decode, and report whether it parses as a feed. A failure is "not a feed" so the caller's loop keeps going. */
export async function probeIsFeed(deps: { fetchBytes: (url: string) => Promise<Uint8Array> }, url: string, maxBytes: number) {
  try {
    const buf = await deps.fetchBytes(url);
    checkResponseBytes(buf, maxBytes, url);
    const text = await decodeXmlBody(buf, url);
    const isFeed = isFeedDocument(text);
    return { text: isFeed ? text : null, status: 200 as number | null, isFeed, reason: isFeed ? "is_feed_document" : "not_feed_document" };
  } catch (e) {
    const msg = (e as Error).message;
    const status = httpStatusOf(msg);
    return { text: null, status, isFeed: false, reason: status ? `HTTP ${status}` : msg.includes("bytes") ? "oversize_response" : "fetch_error" };
  }
}

/** Locate a feed for `sourceUrl`: is the source itself a feed, else a `<link>` tag on its homepage or a common feed path, first that parses as a feed. One fetch serves both checks. The probe trail is kept. */
export async function discoverFeed(deps: { fetchBytes: (url: string) => Promise<Uint8Array> }, { sourceUrl, maxFeedResponseBytes = DEFAULT_MAX_FEED_RESPONSE_BYTES }: { sourceUrl: string; maxFeedResponseBytes?: number }) {
  let html = "";
  let error: string | null = null;
  let status: number | null = null;
  let bytes = 0;
  try {
    const buf = await deps.fetchBytes(sourceUrl);
    bytes = buf.length;
    status = 200;
    checkResponseBytes(buf, maxFeedResponseBytes, sourceUrl);
    html = await decodeXmlBody(buf, sourceUrl);
  } catch (e) {
    error = (e as Error).message;
    status = httpStatusOf(error);
  }
  const links = html ? discoveredFeedLinks(html, sourceUrl) : [];
  const w = html ? detectAccessWall(html, { host: hostOf(sourceUrl) || null, path: safePath(sourceUrl) }) : null;
  const homepageProbe = { status, bytes, alternateLinksFound: links.length, error, wall: w ? { kind: w.class, evidence: w.evidence } : null };
  if (html && isFeedDocument(html)) return { feedUrl: sourceUrl, discoverySource: "source-is-feed" as const, homepageProbe, candidateProbes: [] as Array<{ url: string; status: number | null; isFeedDocument: boolean; reason: string }> };
  const linkSet = new Set(links);
  const candidateProbes: Array<{ url: string; status: number | null; isFeedDocument: boolean; reason: string }> = [];
  for (const candidate of new Set([...links, ...feedCandidateUrls(sourceUrl, sourceContentPath(sourceUrl))])) {
    const p = await probeIsFeed(deps, candidate, maxFeedResponseBytes);
    candidateProbes.push({ url: candidate, status: p.status, isFeedDocument: p.isFeed, reason: p.reason });
    if (p.isFeed) return { feedUrl: candidate, discoverySource: linkSet.has(candidate) ? ("link-alternate" as const) : ("candidate-path" as const), homepageProbe, candidateProbes };
  }
  return null;
}

/** The top-level orchestrator: feed discovery first (the caller walks the feed), the sitemap walk only when no feed is found. */
export async function walkSource(deps: SitemapDeps, opts: SitemapOpts & { sourceUrl: string; maxFeedResponseBytes?: number }) {
  const feed = await discoverFeed(deps, { sourceUrl: opts.sourceUrl, ...(opts.maxFeedResponseBytes !== undefined ? { maxFeedResponseBytes: opts.maxFeedResponseBytes } : {}) });
  if (feed) return { kind: "feed" as const, ...feed };
  return { kind: "sitemap" as const, ...(await walkSitemap(deps, { ...opts, baseUrl: opts.sourceUrl })) };
}
