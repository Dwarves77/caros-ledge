// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2276-2404)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2622-2641)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 3094-3173)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 3558-3599)
// Labelling after a heal. An unverifiable FACT is RE-KINDED, never rewritten (ruling 4, INV-298): to ANALYSIS when its own text is findable verbatim in a section (the claim
// moves to that section if it is not its own), or, for a required-slot claim, to the slot's honest GAP. The old pass also replaced the claim's text with another sentence at a
// Jaccard overlap of 0.15; that is gone: a claim that cannot be re-kinded in place is refused and reported. Paragraph relabelling only prefixes the analysis label.
import { analysisLabelRe, LEGAL_CALLOUT, MODAL_RE } from "@/core/brief";
import { isVerbatim } from "@/core/contracts";
import { buildRecordSlotClaim } from "@/features/intake";

import { locateSpan, type HealClaim } from "./ground";

const LABEL_RE = analysisLabelRe("per the workspace's reading");
const FACT_MARKER = /^\*{0,2}FACT:\*{0,2}\s*/i;
const SLOT_MARKER = /^\[([a-z0-9_]+)\]\s/i;
export const DEFAULT_LABEL = "*Analytical inference:* ";
export interface Sec { id: string; section_key?: string; content_md: string | null }

export const slotKeyOf = (claimText: string): string | null => SLOT_MARKER.exec(claimText)?.[1] ?? null;

function paragraphs(text: string): { parts: string[]; seps: string[] } {
  const parts: string[] = [];
  const seps: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/\n[ \t]*\n/g)) {
    parts.push(text.slice(last, m.index));
    seps.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return { parts, seps };
}
const rejoin = (parts: string[], seps: string[]): string => parts.reduce((acc, p, i) => (i === 0 ? p : acc + (seps[i - 1] ?? "") + p), "");
const asCapture = (text: string) => ({ id: "para", result_url: null, result_content: text });

/** Prefix the analysis label on the paragraph that carries the claim (dropping a leading FACT marker). Null when no unlabelled paragraph carries it. */
export function planRelabelParagraph(contentMd: string, claimText: string): { content_md: string; before: string; after: string } | null {
  const { parts, seps } = paragraphs(contentMd);
  const needle = claimText.trim();
  const i = needle ? parts.findIndex((p) => !LABEL_RE.test(p) && locateSpan(needle, asCapture(p)) != null) : -1;
  if (i === -1) return null;
  const before = parts[i] ?? "";
  const next = [...parts];
  next[i] = DEFAULT_LABEL + before.replace(FACT_MARKER, "").replace(/^\s+/, "");
  return { content_md: rejoin(next, seps), before: before.trim(), after: (next[i] ?? "").trim() };
}
/** The claim is in the full brief but not its section: append it as a labelled paragraph so it can be validated in place (opt-in, with the strip). */
export function planRelabelFromFullBrief(section: Sec, claimText: string, fullBrief: string | null): { content_md: string; after: string } | null {
  const claim = claimText.trim();
  const md = section.content_md ?? "";
  if (!claim || locateSpan(claim, asCapture(md)) || !locateSpan(claim, asCapture(fullBrief ?? ""))) return null;
  const paragraph = DEFAULT_LABEL + claim;
  return { content_md: md + (md.trim() ? "\n\n" : "") + paragraph, after: paragraph.trim() };
}
/** A modal assertion (`requires`, `must`...) with no label and no legal callout gets the analysis label (criterion 4). */
export function planRelabelModal(contentMd: string): { content_md: string; before: string; after: string } | null {
  const { parts, seps } = paragraphs(contentMd);
  const i = parts.findIndex((p) => MODAL_RE.test(p) && !LABEL_RE.test(p) && !p.toLowerCase().includes(LEGAL_CALLOUT.toLowerCase()));
  if (i === -1) return null;
  const before = parts[i] ?? "";
  const next = [...parts];
  next[i] = DEFAULT_LABEL + before;
  return { content_md: rejoin(next, seps), before: before.trim(), after: (next[i] ?? "").trim() };
}
export function sectionNeedsRelabel(section: Sec, claims: HealClaim[]): boolean {
  const md = section.content_md ?? "";
  return !!md.trim() && MODAL_RE.test(md) && !LABEL_RE.test(md) && !md.toLowerCase().includes(LEGAL_CALLOUT.toLowerCase()) && !claims.some((c) => c.claim_kind === "FACT" && c.section_row_id === section.id);
}

export type ReclassifyPlan =
  | { kind: "gap"; slotKey: string; claim_text: string }
  | { kind: "analysis"; sectionId: string | null; moved: boolean }
  | { kind: "refused"; reason: string };
/** Decide how an unverifiable FACT is re-kinded. The claim's text is never changed (a slot GAP replaces the slot marker's FACT with the slot's own honest GAP statement). */
export function planReclassify(claim: HealClaim, sections: Sec[], requiredSlots: readonly string[], sourceUrl: string | null): ReclassifyPlan {
  const slot = slotKeyOf(claim.claim_text);
  if (slot && requiredSlots.includes(slot)) return { kind: "gap", slotKey: slot, claim_text: buildRecordSlotClaim(slot, { capturedText: "", sourceUrl }).claim_text };
  const own = sections.find((s) => s.id === claim.section_row_id);
  if (own && isVerbatim(own.content_md, claim.claim_text)) return { kind: "analysis", sectionId: own.id, moved: false };
  const elsewhere = sections.find((s) => isVerbatim(s.content_md, claim.claim_text));
  return elsewhere ? { kind: "analysis", sectionId: elsewhere.id, moved: true } : { kind: "refused", reason: "claim_text_not_found_verbatim_in_any_section" };
}
