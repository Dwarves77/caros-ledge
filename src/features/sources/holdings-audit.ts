// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 1-134)
// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 157-176)
import { toText } from "@/core/fetch/classify-body";

import { SNAPSHOT_STUB_MAX } from "./snapshot-verify";

/** Furniture is a substantial HTML payload whose visible text is negligible (chrome, nav, script only). */
const FURNITURE_MIN_BYTES = 4000;
const FURNITURE_MAX_CLEAN = 1500;
const FURNITURE_MAX_RATIO = 0.15;

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

/** Publisher-shape structural truncation: the opening structure present and the mandatory closing formula absent. Fires only on that strong evidence; shapes without reliable markers never fire. */
export function structuralTruncation(cleanText: string, shape: PublisherShape): { truncated: boolean; checked: boolean; evidence: string | null } {
  const t = String(cleanText || "");
  const rule: Record<string, { open: RegExp; close: RegExp; what: string }> = {
    "eur-lex": { open: /\bArticle\s+1\b/, close: /(shall be binding in its entirety|shall enter into force|Done at\s+[A-Z]|For the European Parliament|For the Council)/i, what: "eur-lex: Article 1 present but no binding/enter-into-force/Done-at closing formula" },
    "legislation.gov.uk": { open: /(Citation and commencement|\bSCHEDULE\b|^\s*1\s|PART\s+1\b)/i, close: /(came into force|Explanatory Note|Crown copyright|SCHEDULE\s+\d|Changes to legislation)/i, what: "legislation.gov.uk: opening structure present but no closing/footer" },
    "federal-register": { open: /(SUPPLEMENTARY INFORMATION|\bSUMMARY:|\bAGENCY:|\bACTION:)/i, close: /(List of Subjects|Dated:\s|BILLING CODE|Signing Authority|PART\s+\d+\s+is amended)/i, what: "federal-register: SUMMARY/AGENCY/ACTION opening present but no closing" },
  };
  const r = rule[shape];
  if (!r) return { truncated: false, checked: false, evidence: null };
  return r.open.test(t) && !r.close.test(t) ? { truncated: true, checked: true, evidence: r.what } : { truncated: false, checked: true, evidence: null };
}

export type Completeness = "NO-KNOWN-DEFECT" | "TRUNCATED" | "FURNITURE" | "STUB";
/** A capture's completeness against the known defect classes. Metadata alone decides only STUB (by bytes); a body also runs the furniture and structural checks. */
export function classifyCompleteness(cap: { bytes?: number; body?: string | null; shape?: string; usablePoolRows?: number; capture_kind?: string } = {}): { completeness: Completeness; checksFired: string[]; cleanChars: number | null; evidence: Record<string, unknown> } {
  const bytes = Number(cap.bytes || 0);
  const kind = cap.capture_kind || (cap.bytes != null || cap.body != null ? "snapshot" : "pool");
  const checksFired: string[] = [];
  const evidence: Record<string, unknown> = { bytes };
  if (kind === "pool") {
    const rows = Number(cap.usablePoolRows || 0);
    evidence.usablePoolRows = rows;
    checksFired.push("pool-row-count");
    return { completeness: rows <= 0 ? "STUB" : "NO-KNOWN-DEFECT", checksFired, cleanChars: null, evidence };
  }
  checksFired.push("byte-size");
  if (bytes <= SNAPSHOT_STUB_MAX) return { completeness: "STUB", checksFired, cleanChars: null, evidence: { ...evidence, stub: `<= ${SNAPSHOT_STUB_MAX} bytes (JS/error shell)` } };
  if (cap.body == null) return { completeness: "NO-KNOWN-DEFECT", checksFired, cleanChars: null, evidence: { ...evidence, note: "body not read; only the byte-size check ran" } };
  const clean = extractCleanText(cap.body);
  const ratio = bytes > 0 ? clean.length / bytes : 0;
  Object.assign(evidence, { cleanChars: clean.length, ratio: Number(ratio.toFixed(4)) });
  checksFired.push("furniture-ratio");
  if (bytes >= FURNITURE_MIN_BYTES && clean.length < FURNITURE_MAX_CLEAN && ratio < FURNITURE_MAX_RATIO) return { completeness: "FURNITURE", checksFired, cleanChars: clean.length, evidence: { ...evidence, furniture: `bytes ${bytes}, cleanChars ${clean.length}: chrome/nav dominates` } };
  const st = structuralTruncation(clean, (cap.shape || "other") as PublisherShape);
  if (st.checked) checksFired.push("structural-shape");
  return st.truncated ? { completeness: "TRUNCATED", checksFired, cleanChars: clean.length, evidence: { ...evidence, structural: st.evidence } } : { completeness: "NO-KNOWN-DEFECT", checksFired, cleanChars: clean.length, evidence };
}

/**
 * Capture-level sufficiency for grounding THIS item: a source at or above the item's authority floor with real content covers grounding; below the floor it is corroborators-only;
 * a defect-thin capture is insufficient. A floor-exempt type has no tier floor. `authorityFloorFor` is the grounding slice's, injected.
 */
export function classifySufficiency(q: { itemType?: string | null; sourceTier?: number | null; completeness: string; usablePoolRows?: number; snapshotBytes?: number }, deps: { authorityFloorFor: (itemType: string | null | undefined) => number | null }): "covers_grounding" | "corroborators_only" | "insufficient" {
  const hasContent = q.completeness !== "STUB" && (Number(q.snapshotBytes || 0) > SNAPSHOT_STUB_MAX || Number(q.usablePoolRows || 0) >= 2);
  if (!hasContent) return "insufficient";
  const floor = deps.authorityFloorFor(q.itemType);
  if (floor == null) return "covers_grounding";
  const tier = q.sourceTier == null ? null : Number(q.sourceTier);
  if (tier == null) return "corroborators_only";
  return tier <= floor ? "covers_grounding" : "corroborators_only";
}
