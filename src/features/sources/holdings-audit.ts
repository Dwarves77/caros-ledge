// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 1-134)
// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 157-176)
import { toText } from "@/core/fetch/classify-body";
import { hostFamily, type HostFamily } from "@/core/intake/identity";

export type PublisherShape = "eur-lex" | "legislation.gov.uk" | "federal-register" | "gazette" | "other";
const SHAPE_OF: Record<HostFamily, PublisherShape> = { eurlex: "eur-lex", uk_legislation: "legislation.gov.uk", federal_register: "federal-register", us_code: "federal-register", gazette: "gazette" };
/** The publisher shape of a URL's host (the families are data: core/intake/data/publisher-hosts.json); only the four shapes the operator named carry structural markers. */
export function detectPublisherShape(url: string | null | undefined): PublisherShape {
  const family = hostFamily(url);
  return family ? SHAPE_OF[family] : "other";
}
/** Clean visible text: scripts, styles and comments removed, then the one `toText`. */
export const extractCleanText = (body: string | null | undefined): string =>
  toText(String(body || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();


