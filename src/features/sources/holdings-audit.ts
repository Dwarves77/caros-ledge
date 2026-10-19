// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 1-134)
// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 157-176)
import { toText } from "@/core/fetch/classify-body";

export type PublisherShape = "eur-lex" | "legislation.gov.uk" | "federal-register" | "gazette" | "other";
/** Registrable-domain to publisher shape; only the four shapes the operator named carry structural markers. */
export function detectPublisherShape(url: string | null | undefined): PublisherShape {
  const u = String(url || "").toLowerCase();
  if (!u) return "other";
  if (/eur-lex\.europa\.eu|\beurlex\b/.test(u)) return "eur-lex";
  if (/legislation\.gov\.uk/.test(u)) return "legislation.gov.uk";
  if (/federalregister\.gov|govinfo\.gov|ecfr\.gov/.test(u)) return "federal-register";
  if (/gazette|gazzetta|boe\.es|legifrance|bundesanzeiger|staatsblad|dziennik|gesetzblatt/.test(u)) return "gazette";
  return "other";
}
/** Clean visible text: scripts, styles and comments removed, then the one `toText`. */
export const extractCleanText = (body: string | null | undefined): string =>
  toText(String(body || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

export type Completeness = "NO-KNOWN-DEFECT" | "TRUNCATED" | "FURNITURE" | "STUB";

