// Ported from old_repo/src/lib/sources/target-match.mjs (lines 1-172)
// Ported from old_repo/src/lib/sources/target-match.mjs (lines 208-308)
import { classifyIdentifier } from "@/core/census/identity";
import { euCandidates, parseYearNumber } from "@/core/fetch/candidates";
import { decodeUriOrNull } from "@/core/shared/url";

const YEAR_LO = 1950;
const YEAR_HI = 2099;
const isYear = (n: number) => n >= YEAR_LO && n <= YEAR_HI;
const pairKey = (p: { year: number; number: number }) => `${p.year}/${p.number}`;

/** A year plus a number from a pair in either EU order: the token in the year range is the year; neither in range is not an instrument pair. */
function normPair(a: string, b: string): { year: number; number: number } | null {
  const na = Number(a);
  const nb = Number(b);
  if (isYear(na) && !isYear(nb)) return { year: na, number: nb };
  if (isYear(nb) && !isYear(na)) return { year: nb, number: na };
  return null;
}
/**
 * Every pair key an "N/N" occurrence can denote, keeping information. A structural form (CELEX, trailing suffix) parses positionally. An ambiguous prose pair
 * where BOTH halves are year-like (EU serials now exceed 2000: 2025/2083) keeps BOTH readings; the reversal is neutralised at the comparison site.
 */
function pairKeysFor(a: string, b: string, { yearFirst = false } = {}): string[] {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return [];
  if (yearFirst) return isYear(na) ? [pairKey({ year: na, number: nb })] : [];
  if (isYear(na) && isYear(nb)) return [pairKey({ year: na, number: nb }), pairKey({ year: nb, number: na })];
  const p = normPair(a, b);
  return p ? [pairKey(p)] : [];
}

/** Instrument identifiers in a CLEAR instrument context, as normalised pair keys: a CELEX token, "Regulation (EU) n/n" prose, and the trailing "2014/95/EU" form. A bare "2024/1610" counts for nothing. */
export function scanInstrumentIds(text: string | null | undefined): Set<string> {
  const s = String(text || "");
  const found = new Set<string>();
  for (const m of s.matchAll(/\b3(\d{4})[RLD](\d{4})\b/g)) for (const k of pairKeysFor(m[1] ?? "", m[2] ?? "", { yearFirst: true })) found.add(k);
  for (const m of s.matchAll(/\b(regulation|directive|decision|reg\.?|dir\.?)\b[^\n.;]{0,40}?\(?\b(?:eu|ec)\b\)?\s*(?:no\.?\s*)?(\d{1,4})\s*\/\s*(\d{1,4})/gi)) for (const k of pairKeysFor(m[2] ?? "", m[3] ?? "")) found.add(k);
  for (const m of s.matchAll(/\b(\d{4})\s*\/\s*(\d{1,4})\s*\/\s*(?:eu|ec)\b/gi)) for (const k of pairKeysFor(m[1] ?? "", m[2] ?? "", { yearFirst: true })) found.add(k);
  return found;
}

export interface TargetItem {
  title?: string | null;
  subject?: string | null;
  canonicalKey?: string | null;
  canonical_instrument_key?: string | null;
  identifier?: string | null;
  instrument_identifier?: string | null;
  itemType?: string | null;
  item_type?: string | null;
  instrumentType?: string | null;
  instrument_type?: string | null;
}
const rawIdOf = (item: TargetItem): string => String(item.identifier || item.instrument_identifier || item.canonicalKey || item.canonical_instrument_key || "").trim();

/** The item's OWN instrument pair keys, derived from its identifier fields and never guessed. */
export function expectedInstrumentIds(item: TargetItem = {}): Set<string> {
  const keys = new Set<string>();
  const yn = parseYearNumber(item.canonicalKey || item.canonical_instrument_key) || parseYearNumber(item.identifier || item.instrument_identifier);
  if (yn) keys.add(`${yn.year}/${yn.number}`);
  const eu = euCandidates({ identifier: item.identifier || item.instrument_identifier || null, canonicalKey: item.canonicalKey || item.canonical_instrument_key || null, itemType: item.itemType || item.item_type || null, instrumentType: item.instrumentType || item.instrument_type || null });
  for (const c of eu.celex) {
    const m = String(c).match(/^3(\d{4})[RLD](\d{4})$/);
    if (m) for (const k of pairKeysFor(m[1] ?? "", m[2] ?? "", { yearFirst: true })) keys.add(k);
  }
  return keys;
}

/** Loose literal presence of a raw non-EU identifier (SB-261, uksi 2024/1234, a docket number): separators and case normalised away; a bare short number never matches. */
function rawIdentifierPresent(item: TargetItem, text: string): string | null {
  const raw = rawIdOf(item);
  if (!raw || raw.length < 3) return null;
  const norm = (x: string) => x.toLowerCase().replace(/[\s._-]+/g, "");
  const r = norm(raw);
  if (r.length < 3 || /^\d{1,2}$/.test(r)) return null;
  return norm(text).includes(r) ? raw : null;
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "of", "to", "in", "on", "by", "or", "as", "at", "is", "its", "climate", "greenhouse", "gas", "gases", "regulation", "directive", "act", "law"]);
/** The fraction of the title's significant tokens present in the capture (generic words removed, so it measures the specific subject). */
export function subjectOverlap(item: TargetItem, text: string): number {
  const toks = [...new Set((String(item.title || item.subject || "").toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)))];
  if (!toks.length) return 0;
  const t = String(text || "").toLowerCase();
  return toks.filter((w) => t.includes(w)).length / toks.length;
}
export const SUBJECT_MATCH_THRESHOLD = 0.6;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MatchVerdict {
  verdict: "match" | "mismatch" | "unverified";
  via: string;
  score: number;
  expected: string[];
  foundOwn: string[];
  conflicting: string[];
  reason: string;
  url?: string | undefined;
}
/** The capture-is-this-instrument verdict. It sets no status: the caller holds or grounds on it. Precision over recall: a false hold is the worst outcome. */
export function verifyTargetMatch(item: TargetItem = {}, captureText = ""): MatchVerdict {
  const text = String(captureText || "");
  const expected = expectedInstrumentIds(item);
  const inText = scanInstrumentIds(text);
  const foundOwn = [...expected].filter((k) => inText.has(k));
  const rawHit = rawIdentifierPresent(item, text);
  if (foundOwn.length || rawHit) {
    return { verdict: "match", via: foundOwn.length ? "instrument-id" : "raw-id", score: 1, expected: [...expected], foundOwn: foundOwn.length ? foundOwn : rawHit ? [rawHit] : [], conflicting: [], reason: `capture bears the item's own identifier (${foundOwn[0] || rawHit})` };
  }
  // Reversal closure (load-bearing): an ambiguous prose pair contributes both readings, so the reversal of the item's own key is an artefact, never a foreign instrument.
  const reverseOf = (k: string) => k.split("/").reverse().join("/");
  const closure = new Set([...expected, ...[...expected].map(reverseOf)]);
  const conflicting = [...inText].filter((k) => !closure.has(k));
  if (expected.size > 0 && conflicting.length) {
    return { verdict: "mismatch", via: "conflicting-instrument-id", score: 0, expected: [...expected], foundOwn: [], conflicting, reason: `capture bears a different instrument identifier (${conflicting.join(", ")}); the item's own identifier (${[...expected].join(", ")}) is absent` };
  }
  const score = subjectOverlap(item, text);
  if (score >= SUBJECT_MATCH_THRESHOLD) return { verdict: "match", via: "subject-overlap", score: round2(score), expected: [...expected], foundOwn: [], conflicting, reason: `no identifier signal; subject overlap ${round2(score)} >= ${SUBJECT_MATCH_THRESHOLD}` };
  return { verdict: "unverified", via: "subject-overlap-below-threshold", score: round2(score), expected: [...expected], foundOwn: [], conflicting, reason: `no identifier match and subject overlap ${round2(score)} < ${SUBJECT_MATCH_THRESHOLD}: capture not confirmed to be this instrument` };
}
/** Both mismatch and unverified hold. */
export const targetMatchHolds = (verdict: string): boolean => verdict !== "match";

/** True when the URL itself bears the item's own identifier: a CELEX (with or without its corrigendum suffix), a UK series path, or a literal raw identifier. */
export function identifierInUrl(item: TargetItem = {}, url = ""): boolean {
  const raw = rawIdOf(item);
  if (!raw || !url) return false;
  const decoded = decodeUriOrNull(url) ?? String(url);
  const haystacks = decoded === url ? [String(url)] : [String(url), decoded];
  const cls = classifyIdentifier(raw);
  if (cls.scheme === "celex") {
    const base = cls.normalized.match(/^([0-9CE]\d{4}[A-Z]{1,2}\d{2,4})(\(\d{2}\))?$/)?.[1];
    if (base && haystacks.some((h) => h.toUpperCase().includes(base))) return true;
  } else if (cls.scheme === "uk-legislation") {
    if (haystacks.some((h) => h.toLowerCase().includes(`/${cls.normalized}`))) return true;
  }
  return Boolean(rawIdentifierPresent(item, decoded) || rawIdentifierPresent(item, url));
}

/**
 * Target match over the WHOLE fetched pool, so a wrong-instrument primary does not hard-hold while the right one is present as a corroborator.
 * Precedence: a block whose own URL bears the item's identifier (decided before any text verdict); any block whose text matches; any mismatch when none matches; else unverified.
 */
export function verifyPoolTargetMatch(item: TargetItem = {}, blocks: Array<{ url?: string; text?: string }> = []) {
  for (const b of blocks) {
    if (b?.url && identifierInUrl(item, b.url)) {
      const best: MatchVerdict = { url: b.url, verdict: "match", via: "own-url", score: 1, expected: [...expectedInstrumentIds(item)], foundOwn: [], conflicting: [], reason: `the block's own URL bears the item's own identifier (${b.url})` };
      return { verdict: "match" as const, best, mismatches: [] as MatchVerdict[] };
    }
  }
  const verdicts = blocks.filter((b) => b?.text).map((b) => ({ url: b.url, ...verifyTargetMatch(item, b.text) }));
  const matched = verdicts.find((v) => v.verdict === "match");
  if (matched) return { verdict: "match" as const, best: matched, mismatches: [] as MatchVerdict[] };
  const mismatches = verdicts.filter((v) => v.verdict === "mismatch");
  if (mismatches.length) return { verdict: "mismatch" as const, best: mismatches[0] as MatchVerdict, mismatches };
  const best: MatchVerdict = [...verdicts].sort((a, b) => (b.score || 0) - (a.score || 0))[0] ?? { verdict: "unverified", via: "empty-pool", score: 0, conflicting: [], foundOwn: [], expected: [], reason: "empty pool" };
  return { verdict: "unverified" as const, best, mismatches: [] as MatchVerdict[] };
}
