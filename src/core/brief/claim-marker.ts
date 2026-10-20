// New in R2f F7 (K:50, rule 20): the claim a fact paragraph states is NAMED in the paragraph, never inferred at render. A section paragraph carries `<!-- claim:<uuid> -->` on its own first line (an HTML comment: invisible in the render);
// the fact model reads it into FactParagraph.claimId and the card reads its tier and source link from that claim's row by id. A paragraph with no marker draws no tier and no link.
// The marker is written once, where the claim and the paragraph meet: the grounding pass that has just written the claims (bindClaimMarkers, below) and the one-time backfill of what already stood (migration 0108_data_claim_markers, which
// applies the SAME rule in SQL and records the counts). The rule: the ONE FACT claim of the item whose text is verbatim (the database rule, isVerbatim) in the paragraph and is at least MIN_BOUND_CHARS long; none, or two different claims,
// binds nothing. Nothing at render time compares text.
import { isVerbatim } from "@/core/contracts/verbatim";

/** A claim text shorter than this is too short to name a paragraph (the floor the old tier match used): it binds nothing. */
const MIN_BOUND_CHARS = 24;
const MARKER = /^[ \t]*<!--\s*claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-->[ \t]*\r?\n?/i;
const BLANK_LINE = /(\n\s*\n)/;
/** A record-grade line (`[slot_key] ...`) is read by its exact line, not by a card: it takes no marker. */
const SLOT_LINE = /^\s*(?:-\s+)?\[[a-z0-9_]+\]/i;

const claimMarker = (claimId: string): string => `<!-- claim:${claimId} -->`;
/** The claim id a paragraph names, or null. */
export const claimIdOfParagraph = (paragraph: string): string | null => MARKER.exec(paragraph)?.[1]?.toLowerCase() ?? null;
/** The paragraph without its marker line. */
export const withoutClaimMarker = (paragraph: string): string => paragraph.replace(MARKER, "");

/** `marked` and `unmarked` count the paragraphs this call tried to bind; `already` those that named a claim before, `skipped` the record-grade slot lines. */
export interface BindResult { markdown: string; marked: number; unmarked: number; already: number; skipped: number }
/** Mark every fact paragraph that names no claim yet with the ONE claim whose text is verbatim in it. Separators are kept byte for byte; a paragraph that already carries a marker is left as it is. */
export function bindClaimMarkers(markdown: string, claims: readonly { id: string; claim_text: string; claim_kind?: string }[]): BindResult {
  const usable = claims.filter((c) => (c.claim_kind ?? "FACT") === "FACT" && c.claim_text.trim().length >= MIN_BOUND_CHARS);
  const n = { marked: 0, unmarked: 0, already: 0, skipped: 0 };
  const parts = markdown.split(BLANK_LINE).map((part, i) => {
    if (i % 2 === 1 || !part.trim()) return part;
    if (MARKER.test(part)) {
      n.already += 1;
      return part;
    }
    if (SLOT_LINE.test(part)) {
      n.skipped += 1;
      return part;
    }
    const hits = new Set(usable.filter((c) => isVerbatim(part, c.claim_text)).map((c) => c.id));
    if (hits.size !== 1) {
      n.unmarked += 1;
      return part;
    }
    n.marked += 1;
    return `${claimMarker([...hits][0] as string)}\n${part}`;
  });
  return { markdown: parts.join(""), ...n };
}
