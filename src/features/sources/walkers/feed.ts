// Ported from old_repo/src/lib/sources/feed-discovery.mjs (lines 1-61)
// Ported from old_repo/src/lib/sources/feed-walk.mjs (lines 20-70)
import { isErrorBody } from "@/core/fetch/classify-body";

import { inner, strip } from "./xml";

/** Does `text` look like an RSS, Atom or RDF feed document? Only the first 1,500 characters are checked: the root element always appears early. */
export const isFeedDocument = (text: unknown): boolean => /<(?:rss|feed|(?:[\w-]+:)?RDF)[\s>]/i.test(String(text ?? "").slice(0, 1500));

function htmlAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] || match?.[2] || match?.[3] || "";
}
const absoluteLink = (href: string, base: string): string => {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
};
const FEED_LINK_TYPE_RE = /^(?:application\/(?:rss\+xml|atom\+xml|rdf\+xml|xml)|text\/xml)$/;
/** Every `<link>` in `html` declaring a feed MIME type, resolved against `base` (rel="alternate" is not required: some publishers omit it). */
export function discoveredFeedLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const [tag] of String(html ?? "").matchAll(/<link\b[^>]*>/gi)) {
    if (!FEED_LINK_TYPE_RE.test(htmlAttribute(tag, "type").toLowerCase())) continue;
    const href = htmlAttribute(tag, "href");
    const abs = href ? absoluteLink(href, base) : "";
    if (abs) out.push(abs);
  }
  return out;
}
/** Common feed paths a site may serve without declaring a `<link rel="alternate">`. */
export const FEED_CANDIDATE_PATHS = ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"] as const;
/** The ordered feed-candidate URLs for a source: path-scoped first (when registered under a path, not the bare origin), then bare-origin; deduped. */
export function feedCandidateUrls(sourceUrl: string, scopePath = ""): string[] {
  const origin = new URL(sourceUrl).origin;
  const scoped = scopePath ? FEED_CANDIDATE_PATHS.map((s) => `${origin}${scopePath}${s}`) : [];
  return [...new Set([...scoped, ...FEED_CANDIDATE_PATHS.map((s) => `${origin}${s}`)])];
}

export interface FeedEntry {
  url: string;
  anchorText: string | null;
  published: string | null;
}
/** RSS 2.0 `<item>` and Atom `<entry>` blocks as rows. https links only; an entry without a resolvable link is dropped. */
export function parseFeedEntries(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const b of String(xml ?? "").match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) ?? []) {
    let link = inner(b, "link");
    if (!link || !/^https?:\/\//i.test(link)) {
      const atom = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = atom ? strip(atom[1]) : null;
    }
    if (!link || !/^https:\/\//i.test(link)) continue;
    const title = inner(b, "title");
    out.push({ url: link, anchorText: title ? title.slice(0, 300) : null, published: inner(b, "pubDate") || inner(b, "published") || inner(b, "updated") });
  }
  return out;
}
export type Persist = (links: Array<{ url: string; anchorText?: string | null }>) => Promise<{ upserted: number; failed: number }>;
/** Walk one feed: fetch (injected), the error-body gate, parse, persist (injected). An unreadable or blocked body is inconclusive, never an empty feed. */
export async function walkFeed(deps: { fetchText: (url: string) => Promise<string>; persist: Persist }, { feedUrl }: { feedUrl: string }): Promise<{ ok: true; feedUrl: string; entries: number; upserted: number; failed: number } | { ok: false; feedUrl: string; error: string }> {
  let body: string;
  try {
    body = await deps.fetchText(feedUrl);
  } catch (e) {
    return { ok: false, feedUrl, error: `fetch failed: ${(e as Error).message}` };
  }
  if (isErrorBody(body)) return { ok: false, feedUrl, error: "error-body gate: bot-block or error response: inconclusive, not an empty feed" };
  const entries = parseFeedEntries(body);
  if (!entries.length && !/(<rss[\s>]|<feed[\s>])/i.test(body)) return { ok: false, feedUrl, error: `not a feed: no <rss>/<feed> root and 0 entries (${body.length}ch body)` };
  const p = await deps.persist(entries.map((e) => ({ url: e.url, anchorText: e.anchorText })));
  return { ok: true, feedUrl, entries: entries.length, upserted: p.upserted, failed: p.failed };
}
