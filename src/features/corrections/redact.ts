// Ported from old_repo/src/lib/corrections/suppressed-render.mjs (lines 1-118)
// Redaction of suppressed claims from rendered text: the sections, the full brief and every other text column of the item (`redactDeep`: the summary, key data, the stated intersection summary...). Whitespace and escaped
// brackets tolerant. A suppressed claim that was expected in a section and is not found there cannot be removed: the section (and the brief, when the brief does not hold it either) is withheld, never shown with the
// claim in it (INV-270, F:27). The loader reads the fact suppressions the member-readable view exposes (migration 0031) for the items asked, and never reads a claim for an item with no suppression.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { suppressedClaimMatcher } from "@/core/corrections";
import { readFactSuppressionsFor } from "@/core/detail";

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const charPattern = (ch: string): string => (ch === "[" ? "\\\\?\\[" : ch === "]" ? "\\\\?\\]" : ch.replace(REGEX_SPECIALS, "\\$&"));

function claimTextPattern(claimText: string): RegExp {
  const body = claimText.trim().split(/\s+/).map((tok) => Array.from(tok, charPattern).join("")).join("\\s+");
  return new RegExp(`(?:^[ \\t]*[-*+][ \\t]+)?${body}`, "gm");
}

/** Remove one claim's text (with its list marker) from a text; found is false when it is not there. */
export function removeClaimText(text: unknown, claimText: unknown): { text: string; found: boolean } {
  const t = typeof text === "string" ? text : "";
  const c = typeof claimText === "string" ? claimText : "";
  if (!t || !c.trim()) return { text: t, found: false };
  const re = claimTextPattern(c);
  if (!re.test(t)) return { text: t, found: false };
  re.lastIndex = 0;
  return { text: t.replace(re, "").replace(/\n{3,}/g, "\n\n"), found: true };
}

export interface SuppressedClaim {
  id?: string | number | null;
  claim_text: string;
  section_row_id?: string | number | null;
  item_id?: string;
}
export interface SectionLike {
  id?: string | number;
  content_md?: string | null;
  [k: string]: unknown;
}
export interface RedactionReport {
  claim_id: SuppressedClaim["id"];
  claim_text: string;
  section_found: boolean | null;
  brief_found: boolean | null;
}

/** The text with every suppressed claim removed from every string in it (an array entry that was only the claim is dropped): the derived text columns of an item, wherever the claim was copied to. */
export function redactDeep<T>(value: T, claims: readonly SuppressedClaim[] | null | undefined): T {
  if (!claims?.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return claims.reduce((t, c) => removeClaimText(t, c.claim_text).text, v);
    if (Array.isArray(v)) return v.flatMap((x) => { const w = walk(x); return typeof x === "string" && x.trim() !== "" && typeof w === "string" && w.trim() === "" ? [] : [w]; });
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The sections and brief with every suppressed claim removed, plus what was found where. A section whose suppressed claim is not found in it is emptied, and so is the brief when it does not hold the claim either. Nothing is mutated. */
export function redactSuppressedClaims<S extends SectionLike>(input: { sections?: readonly S[] | null; fullBrief?: string | null; claims?: readonly SuppressedClaim[] | null }): { sections: S[]; fullBrief: string | null | undefined; report: RedactionReport[] } {
  const outSections = (input.sections ?? []).map((s) => ({ ...s }));
  let brief = input.fullBrief;
  const report: RedactionReport[] = [];
  for (const claim of input.claims ?? []) {
    let sectionFound: boolean | null = null;
    if (claim.section_row_id) {
      const target = outSections.find((s) => s.id !== undefined && String(s.id) === String(claim.section_row_id));
      if (target) {
        const r = removeClaimText(target.content_md, claim.claim_text);
        target.content_md = r.text;
        sectionFound = r.found;
      }
    }
    let briefFound: boolean | null = null;
    if (typeof brief === "string" && brief) {
      const r = removeClaimText(brief, claim.claim_text);
      brief = r.text;
      briefFound = r.found;
    }
    report.push({ claim_id: claim.id, claim_text: claim.claim_text, section_found: sectionFound, brief_found: briefFound });
    if (sectionFound === false) {
      const target = outSections.find((s) => s.id !== undefined && String(s.id) === String(claim.section_row_id));
      if (target) target.content_md = "";
      if (briefFound !== true && typeof brief === "string") brief = "";
    }
  }
  return { sections: outSections, fullBrief: brief, report };
}

/** Every claim currently suppressed on the given items. A failed read throws; nothing renders unredacted on a failure. */
export async function loadSuppressedClaims(sb: Db, itemIds: readonly (string | null | undefined)[]): Promise<SuppressedClaim[]> {
  const ids = [...new Set(itemIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const corrections = await readFactSuppressionsFor(sb, ids);
  const withFacts = ids.filter((id) => corrections.some((c) => c.item_id === id && c.target_kind === "fact" && c.op === "suppress" && !c.revoked_at));
  if (!withFacts.length) return [];
  const claims = await fetchAllByIdChunks<{ id: string; claim_text: string; section_row_id: string | null; intelligence_item_id: string }>(
    withFacts,
    async (slice) => {
      const { data, error } = await sb.from("section_claim_provenance").select("id, claim_text, section_row_id, intelligence_item_id").in("intelligence_item_id", slice);
      if (error) throw new Error(`section_claim_provenance read failed: ${error.message}`);
      return data ?? [];
    },
    { manyPerId: true },
  );
  const out: SuppressedClaim[] = [];
  for (const itemId of withFacts) {
    const isSuppressed = suppressedClaimMatcher(corrections, itemId);
    for (const c of claims) {
      if (c.intelligence_item_id !== itemId || !isSuppressed(c)) continue;
      out.push({ item_id: itemId, id: c.id, claim_text: c.claim_text, section_row_id: c.section_row_id ?? null });
    }
  }
  return out;
}
