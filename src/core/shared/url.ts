// Ported from old_repo/src/lib/agent/url-canon.mjs (lines 5-22)
// Ported from old_repo/src/lib/entities/host-from-url.mjs (lines 1-10)
import { canonicalizeUrl } from "@/core/parse";

/** Remove trailing markdown markers glued onto a URL (`*`, backtick). */
export const stripUrlMarkers = (s: string): string => s.replace(/(https?:\/\/[^\s)\]}"'<>*`]+)[*`]+/g, "$1");

/** The one citation-URL canonicaliser: the parse module's canonicalizeUrl (https, host without www, path and query CASE KEPT, query sorted without tracking parameters), mirrored in the database as canonicalize_citation_url. Null stays null. */
export const canonicalUrl = (u: string | null | undefined): string | null => canonicalizeUrl(u);

/** decodeURIComponent that answers null for a malformed % sequence instead of throwing: the caller states what it does without a decoded form. */
export function decodeUriOrNull(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The lower-cased host of a URL or bare host, without `www.`; empty when it does not parse. */
export function hostOf(urlOrHost: string | null | undefined): string {
  const raw = String(urlOrHost || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
