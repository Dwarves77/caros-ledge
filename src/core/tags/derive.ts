// Ported from old_repo/src/lib/connections/derive-tags.mjs (lines 13-32)
// Ported from old_repo/src/lib/connections/derive-tags.mjs (lines 437-555)
// Ported from old_repo/src/lib/connections/tag-aliases.mjs (lines 79-164)
// Ported from old_repo/src/lib/connections/tag-input.mjs (lines 1-129)
// Tag derivation by rule over the held vocabulary: every proposed tag carries the keyword evidence found in the item's own text (title and instrument
// key give high confidence, the body gives medium), capped per field. The alias phrases are folded into the same scorer. assembleTagInput builds the
// bounded text window (the grounded brief, sections, FACT claim text and a prefix-plus-context window of the captured source) the scorer reads.
import type { AdoptedVocabulary } from "@/core/vocabulary/adopted";

import { adoptedKeywordEntries, FIELD_CAPS, KEYWORD_MAP, TAG_FIELDS, type KeywordEntry, type TagField } from "./vocabulary";

export { FIELD_CAPS };
export type Confidence = "high" | "medium";
export interface TagProposal {
  field: TagField;
  tag: string;
  evidence: string;
  confidence: Confidence;
}
const CONFIDENCE_RANK: Readonly<Record<string, number>> = { high: 2, medium: 1 };
/** Whether a proposal's confidence reaches the threshold. An unknown value ranks 0. */
export const meetsConfidence = (confidence: unknown, threshold: Confidence): boolean => (CONFIDENCE_RANK[String(confidence)] ?? 0) >= (CONFIDENCE_RANK[threshold] ?? 0);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A phrase on word boundaries, with an optional plural s. */
const phraseRegex = (phrase: string): RegExp => new RegExp(`\\b${escapeRe(phrase)}s?\\b`, "i");

export interface TagSource {
  id?: string;
  title?: string | null;
  canonical_instrument_key?: string | null;
  full_brief?: string | null;
}

export function deriveTags(item: TagSource | null | undefined, adopted?: Partial<AdoptedVocabulary>): { itemId: string | undefined; proposals: TagProposal[] } {
  const it = item ?? {};
  const titleText = [it.title, it.canonical_instrument_key].filter(Boolean).join(" · ");
  const bodyText = String(it.full_brief ?? "");
  const best = new Map<string, TagProposal>();
  const entries: KeywordEntry[] = [...KEYWORD_MAP, ...adoptedKeywordEntries(adopted)];
  for (const entry of entries) {
    const key = `${entry.field}|${entry.tag}`;
    for (const kw of entry.keywords) {
      const re = phraseRegex(kw);
      const titleMatch = titleText.match(re);
      if (titleMatch) {
        if (best.get(key)?.confidence !== "high") best.set(key, { field: entry.field, tag: entry.tag, evidence: titleMatch[0], confidence: "high" });
        continue;
      }
      const bodyMatch = bodyText.match(re);
      if (bodyMatch && !best.has(key)) best.set(key, { field: entry.field, tag: entry.tag, evidence: bodyMatch[0], confidence: "medium" });
    }
  }
  const rank = { high: 0, medium: 1 } as const;
  const proposals: TagProposal[] = [];
  for (const field of TAG_FIELDS) {
    const inField = [...best.values()].filter((p) => p.field === field);
    inField.sort((a, b) => rank[a.confidence] - rank[b.confidence] || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    proposals.push(...inField.slice(0, FIELD_CAPS[field]));
  }
  return { itemId: it.id, proposals };
}

const DEFAULT_PREFIX_CHARS = 8000;
const DEFAULT_CONTEXT_CHARS = 300;

/** The text window of a capture: the first `prefixChars`, plus `contextChars` around every later occurrence of a vocabulary keyword (so a long document is not read whole). */
function boundedSourceWindow(text: unknown, opts: { prefixChars?: number; contextChars?: number; vocabTerms?: readonly string[]; adopted?: Partial<AdoptedVocabulary> } = {}): string {
  const str = String(text ?? "");
  if (!str) return "";
  const prefixChars = Number.isFinite(opts.prefixChars) ? (opts.prefixChars as number) : DEFAULT_PREFIX_CHARS;
  const contextChars = Number.isFinite(opts.contextChars) ? (opts.contextChars as number) : DEFAULT_CONTEXT_CHARS;
  const terms = new Set<string>();
  for (const entry of [...KEYWORD_MAP, ...adoptedKeywordEntries(opts.adopted)]) for (const kw of entry.keywords) if (kw.trim()) terms.add(kw.trim().toLowerCase());
  for (const kw of opts.vocabTerms ?? []) if (String(kw ?? "").trim()) terms.add(String(kw).trim().toLowerCase());
  const prefix = str.slice(0, prefixChars);
  if (str.length <= prefixChars) return prefix;
  const lower = str.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(term, from);
      if (idx === -1) break;
      from = idx + term.length;
      if (idx < prefixChars) continue;
      ranges.push([Math.max(0, idx - contextChars), Math.min(str.length, idx + term.length + contextChars)]);
    }
  }
  if (!ranges.length) return prefix;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0] as [number, number]];
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1] as [number, number];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return `${prefix}\n...\n${merged.map(([s, e]) => str.slice(s, e)).join("\n...\n")}`;
}

export interface TagInputRow extends TagSource {
  jurisdiction_iso?: string[] | null;
  jurisdictions?: string[] | null;
  sections?: { content_md?: string | null }[] | null;
  claims?: { claim_kind?: string; claim_text?: string | null }[] | null;
  searchResults?: { result_content?: string | null }[] | null;
}
/** The item as the deriver reads it: the grounded text, assembled and bounded. */
export function assembleTagInput(row: TagInputRow | null | undefined, windowOpts: { adopted?: Partial<AdoptedVocabulary> } = {}): TagSource & { jurisdiction_iso: string[] | null; jurisdictions: string[] | null } {
  const r = row ?? {};
  const sectionsText = Array.isArray(r.sections) ? r.sections.map((s) => s?.content_md).filter(Boolean).join("\n\n") : "";
  const factText = Array.isArray(r.claims) ? r.claims.filter((c) => c && c.claim_kind === "FACT" && c.claim_text).map((c) => c.claim_text).join("\n\n") : "";
  const captured = (Array.isArray(r.searchResults) ? r.searchResults : []).map((sr) => sr?.result_content).filter(Boolean).join("\n\n");
  const grounded = [r.full_brief, sectionsText, factText, boundedSourceWindow(captured, windowOpts)].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n\n");
  return { ...(r.id !== undefined ? { id: r.id } : {}), title: r.title ?? null, canonical_instrument_key: r.canonical_instrument_key ?? null, jurisdiction_iso: r.jurisdiction_iso ?? null, jurisdictions: r.jurisdictions ?? null, full_brief: grounded.length ? grounded : null };
}
