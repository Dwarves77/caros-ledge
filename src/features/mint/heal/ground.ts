// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 613-993)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1585-1614)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1695-1858)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2239-2266)
// Grounding a claim in a capture. ONE position-preserving normaliser (entities, soft hyphens, whitespace runs, curly quotes) with a numeric tier that folds a separator
// ONLY when the figure's value is unchanged (INV-298): `1 200 000`, `1,200,000` and `1.200.000` are one value, `35,5 %` and `35.5%` are one value, but a single `12.345`
// against `12,345` is ambiguous (decimal or thousands) and never folds, and a tolerant match may not begin or end inside a longer number (`345` is not `12,345`). Only the
// SEARCH is tolerant: the stored span is always a byte-exact slice of the capture (ADR-016), and a heal never rewrites a claim's text.
import { z } from "zod";

import { authorityFloorFor } from "@/core/grounding";
import { canonicalUrl } from "@/core/shared";
import { foldRun, insideLongerNumber, isVerbatim, normalizeNumeric, type Indexed } from "@/core/contracts";

import orphanRules from "./data/orphan.json";

export { foldRun, insideLongerNumber, normalizeNumeric };

export interface Capture { id: string; result_url: string | null; result_content: string; html?: string | null }
export interface HealClaim { id: string; claim_kind: string; claim_text: string; source_span: string | null; source_id: string | null; search_result_id: string | null; section_row_id: string | null; basis_claim_id?: string | null; source_tier_at_grounding?: number | null }
export interface HealSource { id: string; url: string | null; base_tier: number | null; institution_id: string | null; tier_override?: number | null; status?: string | null }
export interface SourcesIndex { byId: Map<string, HealSource>; byCanonUrl: Map<string, HealSource> }
export interface Located { span: string; method: string }
export interface Bucket extends Capture { source_id: string | null; bucket: "own_canonical" | "tier_qualifying" | "corpus_pool" }

const CURLY: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"' };
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const ENTITY = /^&(#x[0-9a-f]+|#\d+|[a-z]+);/i;
const decodeEntity = (t: string): string | null => {
  if (t.startsWith("#")) {
    const n = t[1]?.toLowerCase() === "x" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
  }
  return ENTITIES[t.toLowerCase()] ?? null;
};

/** The structural normalisation, with a map from every normalised index back to its ORIGINAL index (and a sentinel at the end). */
export function normalizeWithMap(text: string): Indexed {
  let chars = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "&") {
      const m = ENTITY.exec(text.slice(i, i + 12));
      const decoded = m?.[1] ? decodeEntity(m[1]) : null;
      if (m && decoded != null) {
        for (const ch of decoded) { chars += ch; map.push(i); }
        i += m[0].length;
        continue;
      }
    }
    const ch = text[i] ?? "";
    if (ch === "­") { i += 1; continue; }
    if (/\s/.test(ch)) {
      const start = i;
      while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
      chars += " ";
      map.push(start);
      continue;
    }
    chars += CURLY[ch] ?? ch;
    map.push(i);
    i += 1;
  }
  map.push(text.length);
  return { chars, map };
}

interface CapIndex { text: string; lower: string; structural: Indexed; structuralLower: string; numeric: Indexed }
export type IndexCache = Map<string, CapIndex>;
const indexOf = (cap: Capture, cache: IndexCache): CapIndex => {
  let idx = cache.get(cap.id);
  if (!idx) {
    const structural = normalizeWithMap(cap.result_content);
    idx = { text: cap.result_content, lower: cap.result_content.toLowerCase(), structural, structuralLower: structural.chars.toLowerCase(), numeric: normalizeNumeric(cap.result_content) };
    cache.set(cap.id, idx);
  }
  return idx;
};

/** Every occurrence of `n` in `hay` in order; the first whose original slice is not inside a longer number wins. `map` takes a position in `hay` back to the original text (null: identity). */
function scan(hay: string, n: string, map: number[] | null, text: string, method: string): Located | null {
  for (let at = n ? hay.indexOf(n) : -1; at !== -1; at = hay.indexOf(n, at + 1)) {
    const from = map ? map[at] : at;
    const to = map ? map[at + n.length] : at + n.length;
    if (from == null || to == null || to <= from || insideLongerNumber(text, from, to)) continue;
    const span = map ? text.slice(from, to).trim() : text.slice(from, to);
    if (span) return { span, method };
  }
  return null;
}
function locateCore(needle: string, idx: CapIndex): Located | null {
  const exact = scan(idx.text, needle, null, idx.text, "exact");
  if (exact) return exact;
  const n = normalizeWithMap(needle).chars;
  const structural = scan(idx.structural.chars, n, idx.structural.map, idx.text, "normalized") ?? scan(idx.structuralLower, n.toLowerCase(), idx.structural.map, idx.text, "normalized_ci");
  if (structural || !/\d/.test(needle)) return structural;
  return scan(idx.numeric.chars, normalizeNumeric(needle).chars, idx.numeric.map, idx.text, "numeric_tolerant");
}
/** The first byte-exact slice of the capture that carries `needle`, by exact, normalised, then value-preserving numeric match. */
export function locateSpan(needle: string, cap: Capture, cache: IndexCache = new Map()): Located | null {
  const n = needle.trim();
  if (!n || !cap.result_content) return null;
  const idx = indexOf(cap, cache);
  return locateCore(n, idx) ?? (n.replace(/[.,;:)\]}]+$/, "") !== n ? locateCore(n.replace(/[.,;:)\]}]+$/, ""), idx) : null);
}

export type GroundPlan = { outcome: "not_applicable" | "already_grounded" | "ungrounded_after_capture" } | { outcome: "healed"; newSpan: string; method: string; searchId: string };
/** A FACT: already grounded when its own attributed capture carries the span; healed when any capture does (re-pointed, text untouched); else ungrounded. */
export function planGrounding(claim: HealClaim, captures: Capture[], cache: IndexCache = new Map()): GroundPlan {
  if (claim.claim_kind !== "FACT") return { outcome: "not_applicable" };
  const own = captures.find((c) => c.id === claim.search_result_id);
  if (claim.source_span && own && isVerbatim(own.result_content, claim.source_span)) return { outcome: "already_grounded" };
  for (const needle of [claim.source_span, claim.claim_text]) {
    if (!needle) continue;
    for (const c of captures) {
      const found = locateSpan(needle, c, cache);
      if (found) return { outcome: "healed", newSpan: found.span, method: needle === claim.claim_text && needle !== claim.source_span ? `claim_text_${found.method}` : found.method, searchId: c.id };
    }
  }
  return { outcome: "ungrounded_after_capture" };
}

// ---- the authority floor and the three re-source buckets -----------------------------------------------------------------------------------------------------------
export const isFloorArmed = (item: { priority?: string | null; item_type?: string | null }): boolean => item.priority === "CRITICAL" || item.priority === "HIGH" || authorityFloorFor(item.item_type) === 2;
const tierOf = (s: HealSource | null | undefined): number | null => s?.base_tier ?? null;
export function buildSourcesIndex(sources: HealSource[]): SourcesIndex {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const byCanonUrl = new Map<string, HealSource>();
  for (const s of sources) {
    const k = canonicalUrl(s.url);
    if (k && !byCanonUrl.has(k)) byCanonUrl.set(k, s);
  }
  return { byId, byCanonUrl };
}
/** A FACT needs a better source when it has none, or (floor armed) its source's tier is above the floor. A standard's own authoring body grounds at tier 4. */
export function claimNeedsResource(claim: HealClaim, item: { item_type: string; priority?: string | null; source_id: string | null }, idx: SourcesIndex): boolean {
  if (claim.claim_kind !== "FACT") return false;
  if (!claim.source_id) return true;
  if (!isFloorArmed(item)) return false;
  const cs = idx.byId.get(claim.source_id) ?? null;
  const is = item.source_id ? idx.byId.get(item.source_id) ?? null : null;
  const own = item.item_type === "standard" && is?.institution_id != null && cs?.institution_id === is.institution_id;
  const floor = own ? 4 : authorityFloorFor(item.item_type);
  const t = tierOf(cs);
  return floor != null && (t == null || t > floor);
}
export function buildBuckets(item: { source_url: string | null; source_id: string | null }, captures: Capture[], idx: SourcesIndex, floor: number | null, corpus: Capture[], itemTier: number | null): Bucket[] {
  const canon = canonicalUrl(item.source_url);
  const own = canon ? captures.filter((c) => canonicalUrl(c.result_url) === canon && c.result_content.trim()).map((c) => ({ ...c, source_id: item.source_id, bucket: "own_canonical" as const })) : [];
  const ownIds = new Set(own.map((b) => b.id));
  const tier = floor == null ? [] : captures.filter((c) => !ownIds.has(c.id) && c.result_url && c.result_content.trim()).flatMap((c) => {
    const s = idx.byCanonUrl.get(canonicalUrl(c.result_url) ?? "");
    return s && tierOf(s) != null && (tierOf(s) as number) <= floor ? [{ ...c, source_id: s.id, bucket: "tier_qualifying" as const }] : [];
  });
  const pool = floor == null || itemTier == null || itemTier > floor ? [] : corpus.filter((c) => c.result_content.trim()).map((c) => ({ id: c.id, result_url: c.result_url, result_content: c.result_content, source_id: item.source_id, bucket: "corpus_pool" as const }));
  return [...own, ...tier, ...pool];
}
export type ResourcePlan = { outcome: "resourced"; newSpan: string; method: string; searchId: string; sourceId: string | null; bucket: Bucket["bucket"] } | { outcome: "unresourced" };
export function planResource(claim: HealClaim, buckets: Bucket[], cache: IndexCache = new Map()): ResourcePlan {
  const needle = claim.source_span || claim.claim_text;
  for (const b of buckets) {
    const f = locateSpan(needle, b, cache);
    if (f) return { outcome: "resourced", newSpan: f.span, method: f.method, searchId: b.id, sourceId: b.source_id, bucket: b.bucket };
  }
  return { outcome: "unresourced" };
}

export interface Orphan { token: string; class: "figure" | "deadline" }
export const findOwningSection = <S extends { content_md: string | null }>(token: string, sections: S[]): S | null => sections.find((s) => (s.content_md ?? "").toLowerCase().includes(token.toLowerCase())) ?? null;

// ---- a Gate A orphan is grounded by a SENTENCE, never by the bare figure -----------------------------------------------------------------------------------------------
// The old heal wrote the claim 'The captured source text states the figure X' with the figure itself as the span: true of any capture that held the string anywhere, so a '10%' in an unrelated paragraph backed any '10%'
// in the brief. Now the claim is the BRIEF'S OWN sentence, the span is the capture's verbatim sentence that carries the figure, and the two must say the same thing (they share their content words above a stated
// overlap, data/orphan.json). An orphan with no such sentence is WITHHELD with the reason `no_verbatim_span` and stays an orphan.
const rules = z.object({ minWordLength: z.number().int().min(2), minSharedWords: z.number().int().min(1), minSharedRatio: z.number().min(0).max(1), maxSpanChars: z.number().int().min(80) }).parse(orphanRules);
export const NO_VERBATIM_SPAN = "no_verbatim_span";
/** A sentence ends at '!', '?', a line break, or a full stop followed by white space or the end (a decimal point does not end one). */
const endsAt = (text: string, i: number): boolean => text[i] === "!" || text[i] === "?" || text[i] === "\n" || (text[i] === "." && (i + 1 >= text.length || /\s/.test(text[i + 1] as string)));

/** The brief's own sentence that states the figure (the claim text of the grounded orphan), or null when the brief has none. */
export function briefSentenceOf(token: string, fullBrief: string | null | undefined): string | null {
  const text = fullBrief ?? "";
  const at = text.toLowerCase().indexOf(token.toLowerCase());
  return at < 0 ? null : sentenceAround(text, at, at + token.length) || null;
}
const contentWords = (s: string, drop: Set<string>): Set<string> => new Set((s.toLowerCase().match(new RegExp(`\\p{L}{${rules.minWordLength},}`, "gu")) ?? []).filter((w) => !drop.has(w)));
/** True when the capture's sentence and the brief's sentence say the same thing: the brief's content words (the figure's own words aside) are shared above the stated overlap. */
function sentencesAgree(brief: string, span: string, token: string): boolean {
  const own = new Set(token.toLowerCase().match(/\p{L}+/gu) ?? []);
  const a = contentWords(brief, own);
  if (!a.size) return false;
  const b = contentWords(span, own);
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared >= Math.min(rules.minSharedWords, a.size) && shared / a.size >= rules.minSharedRatio;
}
/** The sentence of `text` around [from, to): a byte-exact slice bounded by sentence ends and the stated maximum. */
function sentenceAround(text: string, from: number, to: number): string {
  let a = from;
  while (a > 0 && !endsAt(text, a - 1) && from - a < rules.maxSpanChars) a -= 1;
  let b = to;
  while (b < text.length && !endsAt(text, b - 1) && b - to < rules.maxSpanChars) b += 1;
  return text.slice(a, b).trim();
}
/** The verbatim sentence of a capture that carries the figure AND agrees with the brief's sentence, or null (withheld: no_verbatim_span). */
export function supportingSentence(token: string, briefSentence: string, cap: Capture, cache: IndexCache = new Map()): string | null {
  const found = locateSpan(token, cap, cache);
  if (!found) return null;
  const text = cap.result_content;
  for (let at = text.indexOf(found.span); at !== -1; at = text.indexOf(found.span, at + 1)) {
    if (insideLongerNumber(text, at, at + found.span.length)) continue;
    const sentence = sentenceAround(text, at, at + found.span.length);
    if (sentence && sentencesAgree(briefSentence, sentence, token)) return sentence;
  }
  return null;
}
/** An orphan Gate A token grounds on the first bucket whose capture carries a sentence that agrees with the brief's own (or is withheld with `no_verbatim_span`). */
export function planOrphan(o: Orphan, briefSentence: string | null, buckets: Bucket[], cache: IndexCache = new Map()): { found: true; span: string; searchId: string; sourceId: string | null; bucket: Bucket["bucket"] } | { found: false; reason: typeof NO_VERBATIM_SPAN } {
  if (briefSentence) {
    for (const b of buckets) {
      const span = supportingSentence(o.token, briefSentence, b, cache);
      if (span) return { found: true, span, searchId: b.id, sourceId: b.source_id, bucket: b.bucket };
    }
  }
  return { found: false, reason: NO_VERBATIM_SPAN };
}
