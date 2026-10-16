// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 613-993)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1585-1614)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1695-1858)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2239-2266)
// Grounding a claim in a capture. ONE position-preserving normaliser (entities, soft hyphens, whitespace runs, curly quotes) with a numeric tier that folds a separator
// ONLY when the figure's value is unchanged (INV-298): `1 200 000`, `1,200,000` and `1.200.000` are one value, `35,5 %` and `35.5%` are one value, but a single `12.345`
// against `12,345` is ambiguous (decimal or thousands) and never folds, and a tolerant match may not begin or end inside a longer number (`345` is not `12,345`). Only the
// SEARCH is tolerant: the stored span is always a byte-exact slice of the capture (ADR-016), and a heal never rewrites a claim's text.
import { authorityFloorFor } from "@/core/grounding";
import { canonicalUrl } from "@/core/shared";
import { isVerbatim } from "@/core/contracts";

export interface Capture { id: string; result_url: string | null; result_content: string; html?: string | null }
export interface HealClaim { id: string; claim_kind: string; claim_text: string; source_span: string | null; source_id: string | null; search_result_id: string | null; section_row_id: string | null; basis_claim_id?: string | null }
export interface HealSource { id: string; url: string | null; base_tier: number | null; institution_id: string | null }
export interface SourcesIndex { byId: Map<string, HealSource>; byCanonUrl: Map<string, HealSource> }
export interface Located { span: string; method: string }
export interface Bucket extends Capture { source_id: string | null; bucket: "own_canonical" | "tier_qualifying" | "corpus_pool" }

interface Indexed { chars: string; map: number[] }
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

const CODE_OF: Record<string, string> = { "€": "eur", $: "usd", "£": "gbp", "¥": "jpy" };
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUB = "₀₁₂₃₄₅₆₇₈₉";
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "−"]);
const RUN = /\d(?:[., ]\d+)*/g;

/** One run of digits and separators, folded by value: thousands groups drop their separator, a decimal separator becomes `.`, an ambiguous single `,` or `.` stays literal. `offs` maps each output character to its offset in the run. */
export function foldRun(run: string): { text: string; offs: number[] } {
  const parts = [...run.matchAll(/([., ])(\d+)/g)].map((m) => ({ sep: m[1] ?? "", digits: m[2] ?? "" }));
  const lead = run.match(/^\d+/)?.[0] ?? "";
  let text = lead;
  const offs = [...lead].map((_, i) => i);
  let pos = lead.length;
  parts.forEach((p, i) => {
    const three = p.digits.length === 3;
    const later = parts.slice(i + 1).some((q) => q.sep !== p.sep && q.sep !== " ");
    const earlier = parts.slice(0, i).some((q) => q.sep !== p.sep && q.sep !== " ");
    const same = parts.filter((q) => q.sep === p.sep).length;
    let sep: string;
    if (p.sep === " ") sep = three ? "" : " ";
    else if (!three) sep = ".";
    else if (same >= 2 || later) sep = "";
    else if (earlier) sep = ".";
    else sep = p.sep;
    if (sep) { text += sep; offs.push(pos); }
    for (let k = 0; k < p.digits.length; k += 1) { text += p.digits[k]; offs.push(pos + 1 + k); }
    pos += 1 + p.digits.length;
  });
  return { text, offs };
}
/** The numeric-tolerant view: dash variants, super/subscript digits, currency symbol to code, lower-case, no space between a code and its digit or before `%`, runs folded by value. */
export function normalizeNumeric(text: string): Indexed {
  let s = "";
  const m1: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const rep = DASHES.has(ch) ? "-" : SUP.includes(ch) ? String(SUP.indexOf(ch)) : SUB.includes(ch) ? String(SUB.indexOf(ch)) : CODE_OF[ch] ?? ch.toLowerCase();
    for (const c of rep) { s += c; m1.push(i); }
  }
  let t = "";
  const m2: number[] = [];
  for (let i = 0; i < s.length; ) {
    if (/\s/.test(s[i] ?? "")) {
      let j = i;
      while (j < s.length && /\s/.test(s[j] ?? "")) j += 1;
      if (!((/^(eur|usd|gbp|jpy)$/.test(t.slice(-3)) && /\d/.test(s[j] ?? "")) || s[j] === "%")) { t += " "; m2.push(m1[i] ?? 0); }
      i = j;
    } else { t += s[i]; m2.push(m1[i] ?? 0); i += 1; }
  }
  let chars = "";
  const map: number[] = [];
  let last = 0;
  for (const m of t.matchAll(RUN)) {
    for (let k = last; k < m.index; k += 1) { chars += t[k]; map.push(m2[k] ?? 0); }
    const folded = foldRun(m[0]);
    folded.offs.forEach((off, k) => { chars += folded.text[k]; map.push(m2[m.index + off] ?? 0); });
    last = m.index + m[0].length;
  }
  for (let k = last; k < t.length; k += 1) { chars += t[k]; map.push(m2[k] ?? 0); }
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

/** True when [from, to) of `text` begins or ends inside a longer number (`345` in `12,345`, `12` in `12.5`): a match there would ground a DIFFERENT value (INV-298). */
export function insideLongerNumber(text: string, from: number, to: number): boolean {
  const digit = (c: string | undefined) => c !== undefined && /\d/.test(c);
  const sep = (c: string | undefined) => c === "." || c === ",";
  if (digit(text[from]) && (digit(text[from - 1]) || (sep(text[from - 1]) && digit(text[from - 2])))) return true;
  return digit(text[to - 1]) && (digit(text[to]) || (sep(text[to]) && digit(text[to + 1])));
}
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
export const orphanClaimText = (o: Orphan): string => `The captured source text states the ${o.class === "deadline" ? "date" : "figure"} "${o.token}".`;
export const findOwningSection = <S extends { content_md: string | null }>(token: string, sections: S[]): S | null => sections.find((s) => (s.content_md ?? "").toLowerCase().includes(token.toLowerCase())) ?? null;
/** An orphan Gate A token grounds on the first bucket whose capture carries it verbatim (or by value-preserving fold). */
export function planOrphan(o: Orphan, buckets: Bucket[], cache: IndexCache = new Map()): { found: true; span: string; searchId: string; sourceId: string | null; bucket: Bucket["bucket"] } | { found: false } {
  for (const b of buckets) {
    const f = locateSpan(o.token, b, cache);
    if (f) return { found: true, span: f.span, searchId: b.id, sourceId: b.source_id, bucket: b.bucket };
  }
  return { found: false };
}
