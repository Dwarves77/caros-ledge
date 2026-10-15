// Ported from old_repo/src/lib/agent/url-canon.mjs (lines 5-22)
// Ported from old_repo/src/lib/entities/host-from-url.mjs (lines 1-10)

/** Remove trailing markdown markers glued onto a URL (`*`, backtick). */
export const stripUrlMarkers = (s: string): string => s.replace(/(https?:\/\/[^\s)\]}"'<>*`]+)[*`]+/g, "$1");

/** The one citation-URL canonicaliser; a JS mirror of the database function canonicalize_citation_url. Null stays null. */
export function canonicalUrl(u: string | null | undefined): string | null {
  if (u == null) return null;
  return String(u)
    .trim()
    .toLowerCase()
    .replace(/[*`]+$/, "")
    .replace(/^(https?:\/\/)www\./, "$1")
    .replace(/[/.,;:]+$/, "");
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
