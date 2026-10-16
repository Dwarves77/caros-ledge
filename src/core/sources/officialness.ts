// Ported from old_repo/src/lib/sources/officialness.mjs (lines 1-145)
import { MIN_CONTENT_CHARS } from "@/core/fetch/classify-body";

/** About 0.4 link density marks a link-list or menu block, not prose. */
const LINK_DENSITY_MAX = 0.4;
// The block separator is the intentional control character U+0001: it cannot occur in html text, so splitting on it never cuts a real block.
const BLOCK_SEP = "\u0001";

/** Flatten an html fragment to visible text: tags and entities dropped, whitespace collapsed. Blanks entities (htmlToText does not) so a &nbsp; run cannot skew the link-density ratio. */
const stripTags = (s: unknown): string => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&(?:[a-z]+|#\d+);/gi, " ").replace(/\s+/g, " ").trim();
const inkLen = (s: unknown): number => String(s ?? "").replace(/\s+/g, "").length;

/** Remove script, style and chrome containers (nav, header, footer, aside, role=navigation, menu-like ids and classes) with their contents. A no-op on already-flattened text. */
function structuralStrip(html: unknown): string {
  let h = String(html ?? "");
  h = h.replace(/<(script|style|template|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<(\w+)\b[^>]*\brole\s*=\s*["']?navigation["']?[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return h.replace(/<(\w+)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*(?:menu|breadcrumb|cookie|banner|sidebar|footer|skip-?link)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ");
}
const splitBlocks = (html: string): string[] =>
  html.replace(/<\/(p|li|ul|ol|div|section|article|main|tr|table|h[1-6]|blockquote|dd|dt|figcaption)\s*>/gi, BLOCK_SEP).replace(/<br\s*\/?>/gi, BLOCK_SEP).split(BLOCK_SEP);

/** The clean body past the navigation: high-link-density blocks dropped, prose kept; plus the whole-page link density for the audit. */
function cleanBodyOf(html: unknown): { cleanBody: string; cleanLen: number; linkDensity: number } {
  let totalInk = 0;
  let totalAnchorInk = 0;
  const kept: string[] = [];
  for (const block of splitBlocks(structuralStrip(html))) {
    const text = stripTags(block);
    const ink = inkLen(text);
    if (ink === 0) continue;
    const anchorInk = inkLen([...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripTags(m[1])).join(" "));
    totalInk += ink;
    totalAnchorInk += anchorInk;
    const tagCount = (block.match(/<[^>]+>/g) || []).length;
    if (anchorInk / ink >= LINK_DENSITY_MAX) continue;
    if (ink < 30 && anchorInk > 0 && tagCount >= 2) continue;
    kept.push(text);
  }
  const cleanBody = kept.join(" ").replace(/\s+/g, " ").trim();
  return { cleanBody, cleanLen: cleanBody.length, linkDensity: totalInk > 0 ? Math.round((totalAnchorInk / totalInk) * 100) / 100 : 0 };
}

// Primary-instrument markers: the enacted text's own scaffolding, not subject words. A section marker counts only with an obligation verb.
const STRONG_MARKER = /\bArticle\s+\d+\b|\bAnnex\s+[IVXLC]+\b|\bCELEX[:\s]|\bOJ\s+L\s*\d+|\b\d{4}\/\d+\/(?:EU|EC|EEC)\b|\bRecital\s+\d+\b/i;
const SECTION_MARKER = /\bSection\s+\d+\b|\bparagraph\s+\d+\b|\bsub-?paragraph\b|\bpoint\s+\([a-z0-9]+\)/i;
const OBLIGATION_MARKER = /\b(?:shall|must|is required to|are required to|obligation|obligations)\b/i;
export const hasInstrumentMarkers = (cleanBody: unknown): boolean => {
  const b = String(cleanBody ?? "");
  return STRONG_MARKER.test(b) || (SECTION_MARKER.test(b) && OBLIGATION_MARKER.test(b));
};

/**
 * The 4d gate: read the clean, past-the-nav body and decide path a (an official primary instrument) or path b (portal, explainer, chrome). Path a needs BOTH
 * a host that clears the item's floor (floorTier null: floor-exempt) AND a clean body of real length carrying instrument markers. Any miss is path b.
 */
export function officialnessOf(html: unknown, host: string | null | undefined, opts: { hostTier?: number | null; floorTier?: number | null } = {}) {
  const { hostTier = null, floorTier = null } = opts;
  const { cleanBody, cleanLen, linkDensity } = cleanBodyOf(html);
  const h = String(host ?? "").replace(/^www\./, "").toLowerCase();
  const hostQualifies = floorTier == null || (hostTier != null && hostTier <= floorTier);
  const hasBody = cleanLen >= MIN_CONTENT_CHARS;
  const markers = hasInstrumentMarkers(cleanBody);
  if (hostQualifies && hasBody && markers) return { cleanBody, cleanLen, linkDensity, path: "a" as const, reason: `official_instrument host=${h || "?"}` };
  const reason = !hostQualifies ? `sub_floor_host host=${h || "?"} tier=${hostTier == null ? "null" : hostTier} floor=${floorTier}` : !hasBody ? `chrome_or_stub_body cleanLen=${cleanLen}` : `no_instrument_markers cleanLen=${cleanLen}`;
  return { cleanBody, cleanLen, linkDensity, path: "b" as const, reason };
}
