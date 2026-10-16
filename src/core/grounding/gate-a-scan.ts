// Ported from old_repo/src/lib/agent/gate-a-scan.mjs (lines 1-301)
// Ported from old_repo/src/lib/agent/gate-a-match.mjs (lines 1-25)
// Gate A: every figure and deadline a reader could act on must be backed by a FACT claim (literal coverage) or a valid DERIVED
// claim (Gate B). The harvest skips five non-assertion contexts (document metadata stamps, GAP boilerplate clauses, heading and
// list ordinals, instrument-citation numbers, nested sub-spans) and COUNTS every skip, never silently. Citation apparatus is
// provenance metadata, not a fact. A version bump re-scans honestly (INV-017).
import { createHash } from "node:crypto";

import { MONTHS_FULL_RE } from "@/core/brief/vocab";

export const GATE_A_VERSION = "2026-09-04.1";
export const md5 = (s: unknown): string => createHash("md5").update(String(s ?? ""), "utf8").digest("hex");

export const norm = (s: unknown): string => String(s || "").replace(/\s+/g, " ").toLowerCase();
const collapsePct = (s: string) => s.replace(/(\d)[\s  ]+%/g, "$1%");
const PCT_TOKEN = /^\d[\d.,]*%$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The one coverage decision: does `haystack` contain `token` as a normalised literal substring? A numeral+% token matches only at a numeral boundary. */
export function containsToken(haystack: unknown, token: unknown): boolean {
  const t = collapsePct(norm(token));
  if (t.length === 0) return false;
  const h = collapsePct(norm(haystack));
  return PCT_TOKEN.test(t) ? new RegExp(`(?<![\\d.,])${escapeRe(t)}`).test(h) : h.includes(t);
}

export interface SkipCounts { metadata_stamp: number; boilerplate: number; heading_or_list_ordinal: number; instrument_citation: number; citation_url: number; nested_token: number }
const freshCounts = (): SkipCounts => ({ metadata_stamp: 0, boilerplate: 0, heading_or_list_ordinal: 0, instrument_citation: 0, citation_url: 0, nested_token: 0 });

const CITATION_LINE = /\bOJ\b|official journal|\bp{1,2}\.\s?\d|\bpp\.\s?\d|https?:\/\/|\beli\b|celex|\bno\.?\s?\d+\/\d+|\bL\s?\d{2,}|\bC\s?\d{2,}|source\s*[:=]|\bdoi\b|\baccessed\b|©/i;
const OBLIGATION_NEAR = /\b(?:by|from|until|after|before|effective|effective from|starting|as of|no later than|in force|applies|apply from|deadline|phase[- ]?in|phased|comes into force|entry into force|takes effect|by the end of|through|to)\b/i;
const URL_RE = /https?:\/\/[^\s|)\]"'<>]+/g;
const METADATA_LABELS = new Set(["as of", "status", "last verified", "date of generation", "document date", "effective date of this document"]);
const PIPE_HEADER = /^\*\*[^*\n]{1,60}\*\*\s*\|/;
const LABEL_LINE = /^\*\*([^*\n]{1,60}?):?\*\*/;
const BOILERPLATE = [/no content for this section as of\s+([^\n*:.]{1,40})/gi, /not available from primary sources as of\s+([^\n*:.]{1,40})/gi];
const ORDINAL_PREFIX = /^(#{1,6}\s+)?\d+\.(?=\s|$)\s*/;

type Span = [number, number];
const inside = (start: number, end: number, spans: Span[]) => spans.some(([s, e]) => start >= s && end <= e);
const urlSpans = (line: string): Span[] => [...line.matchAll(URL_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
function boilerplateSpans(line: string): Span[] {
  const spans: Span[] = [];
  for (const re of BOILERPLATE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const from = m.index + m[0].lastIndexOf(m[1] ?? "");
      spans.push([from, from + (m[1] ?? "").length]);
    }
  }
  return spans;
}
/** A whole line that is a document-metadata stamp (a document-type header, or a listed label followed by a short value). */
function isMetadataStamp(line: string): boolean {
  if (PIPE_HEADER.test(line)) return true;
  const m = LABEL_LINE.exec(line);
  return !!m && METADATA_LABELS.has((m[1] ?? "").trim().toLowerCase().replace(/:$/, "")) && line.slice(m[0].length).trim().length <= 60;
}
const stripOrdinal = (line: string) => {
  const m = ORDINAL_PREFIX.exec(line);
  return m ? { rest: line.slice(m[0].length), offset: m[0].length, stripped: true } : { rest: line, offset: 0, stripped: false };
};
/** A bare year adjacent to "/" plus another number, in either order (2024/1735, 12,305/2010): an instrument number, not a date. */
const isInstrumentYear = (line: string, start: number, end: number): boolean => line.slice(end, end + 1) === "/" || /[\d,]\/$/.test(line.slice(Math.max(0, start - 4), start));

interface Match { token: string; start: number; end: number }
/** Drop a match nested inside another at the SAME position (a distinct figure sharing digits elsewhere is never collapsed). */
function dedupNested(matches: Match[], counts: SkipCounts): string[] {
  const out = new Set<string>();
  for (const m of matches) {
    if (matches.some((o) => o !== m && !(o.start === m.start && o.end === m.end) && o.start <= m.start && o.end >= m.end)) counts.nested_token += 1;
    else out.add(m.token);
  }
  return [...out];
}

function figureTokens(text: string, counts: SkipCounts): string[] {
  const out = new Set<string>();
  const res = [/(?:€|£|\$|EUR|GBP|USD)\s?\d[\d.,]*/g, /\b\d[\d.,]*\s?(?:%|per ?cent|percent|tCO2e?|tCO₂e?|gCO2|gCO₂|g\/km|\btonnes?\b|\bgt\b|\bkW\b|\bMW\b|\bGW\b|\bkWh\b|\bMWh\b|\bkm\b|\blitres?\b|\bkg\b|\bppm\b|\bbps\b)/gi];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isMetadataStamp(line)) {
      counts.metadata_stamp += 1;
      continue;
    }
    const { rest, offset, stripped } = stripOrdinal(line);
    if (stripped) counts.heading_or_list_ordinal += 1;
    const bSpans = boilerplateSpans(rest);
    const uSpans = urlSpans(rest);
    const matches: Match[] = [];
    for (const re of res) {
      for (const m of rest.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (inside(start, end, uSpans)) counts.citation_url += 1;
        else if (inside(start, end, bSpans)) counts.boilerplate += 1;
        else matches.push({ token: m[0].trim(), start: start + offset, end: end + offset });
      }
    }
    for (const t of dedupNested(matches, counts)) out.add(t);
  }
  return [...out];
}

function deadlineTokens(text: string, counts: SkipCounts): string[] {
  const out = new Set<string>();
  const dateRes = [new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS_FULL_RE})\\s+\\d{4}\\b`, "gi"), new RegExp(`\\b(?:${MONTHS_FULL_RE})\\s+\\d{4}\\b`, "gi"), /\b\d{4}-\d{2}-\d{2}\b/g];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isMetadataStamp(line)) {
      counts.metadata_stamp += 1;
      continue;
    }
    const { rest, offset, stripped } = stripOrdinal(line);
    if (stripped) counts.heading_or_list_ordinal += 1;
    const bSpans = boilerplateSpans(rest);
    const isCitation = CITATION_LINE.test(rest);
    const matches: Match[] = [];
    const before = (start: number) => rest.slice(Math.max(0, start - 30), start);
    for (const re of dateRes) {
      for (const m of rest.matchAll(re)) {
        const start = m.index ?? 0;
        if (isCitation && !OBLIGATION_NEAR.test(before(start))) continue;
        if (inside(start, start + m[0].length, bSpans)) counts.boilerplate += 1;
        else matches.push({ token: m[0].trim(), start: start + offset, end: start + m[0].length + offset });
      }
    }
    const trajectoryRow = rest.includes("|") && /\d[\d.,]*\s?%|(?:€|£|\$)\s?\d/.test(rest);
    for (const ym of rest.matchAll(/\b(?:19[89]\d|20[0-4]\d)\b/g)) {
      const start = ym.index ?? 0;
      const end = start + ym[0].length;
      if (isInstrumentYear(rest, start, end)) counts.instrument_citation += 1;
      else if (isCitation && !OBLIGATION_NEAR.test(before(start))) continue;
      else if (inside(start, end, bSpans)) counts.boilerplate += 1;
      else if (trajectoryRow || OBLIGATION_NEAR.test(before(start))) matches.push({ token: ym[0], start: start + offset, end: end + offset });
    }
    for (const t of dedupNested(matches, counts)) out.add(t);
  }
  return [...out];
}

/** All Gate A tokens in prose: figures and context-aware deadline dates. */
export const extractFactualTokens = (fullBrief: string | null | undefined, counts: SkipCounts = freshCounts()): { figures: string[]; deadlines: string[] } => {
  const text = String(fullBrief || "");
  return { figures: figureTokens(text, counts), deadlines: deadlineTokens(text, counts) };
};

export interface GateAScan { scanned_hash: string; gate_a_version: string; orphan_count: number; orphans: { token: string; class: "figure" | "deadline" }[]; counts: SkipCounts }
/** scanBrief: orphans are factual tokens absent from every FACT claim (literal arm) and from every valid DERIVED claim (`derivedCovered`). */
export function scanGateA(fullBrief: string | null | undefined, factClaims: { claim_text: string; source_span: string }[], derivedCovered: Set<string> = new Set()): GateAScan {
  const counts = freshCounts();
  const { figures, deadlines } = extractFactualTokens(fullBrief, counts);
  const corpus = (factClaims ?? []).map((c) => `${c.claim_text} ${c.source_span}`).join(" ");
  const backed = (tk: string) => containsToken(corpus, tk) || derivedCovered.has(norm(tk));
  const orphans = [...figures.filter((t) => !backed(t)).map((token) => ({ token, class: "figure" as const })), ...deadlines.filter((t) => !backed(t)).map((token) => ({ token, class: "deadline" as const }))];
  return { scanned_hash: md5(fullBrief), gate_a_version: GATE_A_VERSION, orphan_count: orphans.length, orphans, counts };
}
