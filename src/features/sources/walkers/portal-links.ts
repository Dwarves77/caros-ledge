// Ported from old_repo/src/lib/sources/portal-links.mjs (lines 1-47)
const INSTRUMENT_RE = /\b(regulation|regulations|directive|legislation|law|laws|act|acts|statute|decree|ordinance|rulemaking|rule|rules|standard|standards|guidance|circular|notice|consultation|docket|bill|amendment|oj|eli|celex|federal[-_ ]?register|official[-_ ]?journal|compliance|enforcement)\b/i;
/** Path segments that are never instruments (navigation, chrome, assets, socials). */
const EXCLUDE_RE = /\.(css|js|png|jpe?g|gif|svg|ico|woff2?|mp4|zip)(\?|$)|\/(about|contact|careers|jobs|privacy|cookies|accessibility|sitemap|search|login|signin|account|newsletter|subscribe|rss|feed)\b|^(mailto|tel|javascript):/i;
const DEFAULT_CAP = 40;

export interface PortalLink {
  url: string;
  anchorText: string;
}
/** Candidate instrument deep links from portal HTML: same-host only (a cross-host link is a new-SOURCE lead), deduped, capped, with an instrument signal in the path or the anchor text. */
export function extractPortalLinks(html: string, portalUrl: string, opts: { cap?: number } = {}): PortalLink[] {
  const cap = opts.cap ?? DEFAULT_CAP;
  let base: URL;
  try {
    base = new URL(String(portalUrl));
  } catch {
    return [];
  }
  const portalHost = base.host.replace(/^www\./, "").toLowerCase();
  const baseNoSlash = base.toString().replace(/\/$/, "");
  const seen = new Set<string>();
  const out: PortalLink[] = [];
  const anchorRe = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  const source = String(html ?? "");
  for (let m = anchorRe.exec(source); m !== null && out.length < cap; m = anchorRe.exec(source)) {
    const rawHref = (m[2] ?? m[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || EXCLUDE_RE.test(rawHref)) continue;
    let resolved: URL;
    try {
      resolved = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
    if (resolved.host.replace(/^www\./, "").toLowerCase() !== portalHost) continue;
    resolved.hash = "";
    const url = resolved.toString().replace(/\/$/, "");
    if (url === baseNoSlash || resolved.pathname === "/" || resolved.pathname === "") continue;
    const anchorText = (m[4] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!INSTRUMENT_RE.test(resolved.pathname) && !INSTRUMENT_RE.test(anchorText)) continue;
    if (EXCLUDE_RE.test(resolved.pathname) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, anchorText });
  }
  return out;
}
