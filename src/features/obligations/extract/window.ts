// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 151-622)
// The display window of a forward event: the clause around the date, bounded (300 characters before, 160 after), opened at a genuine sentence, paragraph,
// list or `[slot]` boundary, cleaned of table cells, bold labels, FACT/GAP labels, citation keys and URLs, marked with an ellipsis when it is a fragment;
// a record-facts FACT wrapper is unwrapped to the quoted passage that contains the date and a GAP wrapper is skipped. Two boundary scans stay distinct
// because they answer different questions (clauseStart: where the DISPLAYED clause opens; sentenceStart: where the DEONTIC look-behind opens, and it
// treats `;` as a terminator); both share the decimal-point rule. Exact behaviour parity with the old extractor is proven by a golden over the live fixture.
import { ABSENCE_TOKEN } from "@/core/brief";
import { MONTH_EN_ALT, MONTH_PT_ALT } from "@/core/parse/date-grammar";

const SENTENCE_OPEN_RE = /[A-Z0-9"'“‘«(]/;
const isDecimalPoint = (text: string, i: number): boolean => /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "");
function isGenuineTerminatorAt(text: string, i: number): boolean {
  const ch = text[i];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  if (ch === "." && isDecimalPoint(text, i)) return false;
  let j = i + 1;
  if (!/\s/.test(text[j] || "")) return false;
  while (/\s/.test(text[j] || "")) j += 1;
  return SENTENCE_OPEN_RE.test(text[j] || "");
}
const isParagraphBreakAt = (text: string, i: number): boolean => text[i] === "\n" && text[i - 1] === "\n";
const isListOrHeadingBreakAt = (text: string, i: number): boolean => text[i] === "\n" && /^(?:[-*#]|\d+\.)\s/.test(text.slice(i + 1, i + 8));
const SLOT_MARKER_AT_RE = /^\[[a-z][a-z0-9_]*\]\s+/i;
const SLOT_MARKER_ANYWHERE_RE = /\[[a-z][a-z0-9_]*\]\s+/i;
const isSlotMarkerStartAt = (text: string, i: number): boolean => SLOT_MARKER_AT_RE.test(text.slice(i, i + 64));

const DEFAULT_MAX_BEFORE = 300;
const DEFAULT_MAX_AFTER = 160;
const MAX_BEFORE_FOR_MARKER = 3000;

/** Where the displayed clause opens. `fragment` is true when it opens mid-sentence (the text then starts with an ellipsis). */
function clauseStart(text: string, idx: number, maxBefore: number): { pos: number; fragment: boolean } {
  const hardFloor = idx - maxBefore;
  const floor = Math.max(0, hardFloor);
  for (let i = idx - 1; i >= floor; i -= 1) {
    if (isGenuineTerminatorAt(text, i)) {
      let j = i + 1;
      while (/\s/.test(text[j] || "")) j += 1;
      return { pos: j, fragment: false };
    }
    if (isParagraphBreakAt(text, i) || isListOrHeadingBreakAt(text, i)) return { pos: i + 1, fragment: false };
    if (isSlotMarkerStartAt(text, i)) return { pos: i, fragment: false };
  }
  if (hardFloor <= 0) return { pos: floor, fragment: false };
  const markerFloor = Math.max(0, idx - MAX_BEFORE_FOR_MARKER);
  for (let i = floor - 1; i >= markerFloor; i -= 1) if (isSlotMarkerStartAt(text, i)) return { pos: i, fragment: false };
  for (let i = idx - 1; i >= floor; i -= 1) if (text[i] === ";") return { pos: i + 1, fragment: true };
  for (let i = floor; i < idx; i += 1) if (/\s/.test(text[i] as string)) return { pos: i + 1, fragment: true };
  return { pos: floor, fragment: true };
}

/** Where the sentence holding a position closes (one past its `.` or `;`, which is not a decimal point and is followed by white space or the end), or null when none closes within `maxAfter` characters; a blank line also closes it. */
export function sentenceEnd(text: string, idx: number, maxAfter = 400): number | null {
  const ceil = Math.min(text.length, idx + maxAfter);
  for (let i = idx; i < ceil; i += 1) {
    const ch = text[i];
    if ((ch === "." || ch === ";") && !isDecimalPoint(text, i) && /\s/.test(text[i + 1] ?? " ")) return i + 1;
    if (isParagraphBreakAt(text, i + 1)) return i + 1;
  }
  return null;
}

/** Where the sentence holding a trigger opens, for the deontic look-behind: `.` or `;` that is not a decimal point, at most `maxBack` characters back. */
export function sentenceStart(text: string, idx: number, maxBack = 200): number {
  const floor = Math.max(0, idx - maxBack);
  for (let i = idx - 1; i >= floor; i -= 1) {
    const ch = text[i];
    if ((ch === "." || ch === ";") && !isDecimalPoint(text, i)) return i + 1;
  }
  return floor;
}

const YEAR_TOKEN_RE = /\b(?:1[5-9]|2[0-4])\d{2}\b/;
const MONTH_TOKEN_RE = new RegExp(`\\b(?:${MONTH_EN_ALT}|${MONTH_PT_ALT})\\b`, "i");
const ISO_TOKEN_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const cellLooksDated = (cell: string): boolean => YEAR_TOKEN_RE.test(cell) || MONTH_TOKEN_RE.test(cell) || ISO_TOKEN_RE.test(cell);
const SHORT_DATE_CELL_MAX = 35;
const MIN_USABLE_CELL_LEN = 12;

/** In a pipe table row, the cell that explains the date (the one after a short date cell), not the date cell itself. */
function selectDateCell(text: unknown, dateSpan?: string): string {
  if (typeof text !== "string" || !text.includes("|")) return typeof text === "string" ? text : "";
  const cells = text.split("|").map((c) => c.trim()).filter(Boolean);
  if (cells.length === 0) return "";
  if (cells.length === 1) return cells[0] as string;
  let dateCellIdx = -1;
  if (typeof dateSpan === "string" && dateSpan) dateCellIdx = cells.findIndex((c) => c.includes(dateSpan));
  if (dateCellIdx === -1) dateCellIdx = cells.findIndex(cellLooksDated);
  const longest = (): string => {
    const nonUrl = cells.filter((c) => !/^https?:\/\//i.test(c));
    return (nonUrl.length ? nonUrl : cells).reduce((a, b) => (b.length > a.length ? b : a));
  };
  let chosen: string;
  if (dateCellIdx === -1) chosen = longest();
  else if ((cells[dateCellIdx] as string).length >= SHORT_DATE_CELL_MAX) chosen = cells[dateCellIdx] as string;
  else if (dateCellIdx + 1 < cells.length) chosen = cells[dateCellIdx + 1] as string;
  else chosen = cells[dateCellIdx] as string;
  if (chosen.length < MIN_USABLE_CELL_LEN || /^https?:\/\//i.test(chosen)) chosen = longest();
  return chosen;
}

const BOLD_LABEL_RE = /\*\*[^*\n]{1,90}:\*\*\s*/g;
const LABEL_UNIT_RE = new RegExp("(?:[A-Za-z][A-Za-z0-9 ,'()/]{0,60}[\\u2014\\u2013-]\\s*)?\\b(?:FACT|GAP|MONITORING|ANALYSIS)\\b(?:\\s*[\\u2014\\u2013-]\\s*[a-z][a-z ]{0,24})?\\s*:\\s*", "g");
const LEADING_CITATION_KEY_RE = /^[0-9][A-Za-z0-9]{2,14}\*\s*/;
const LEADING_URL_TAIL_RE = /^\S*\/\S*\s+/;
const BARE_URL_RE = /https?:\/\/\S*/gi;

function stripOnePass(t: string, dateSpan?: string): string {
  let out = selectDateCell(t, dateSpan);
  out = out.replace(BOLD_LABEL_RE, "").replace(/\*\*/g, "").replace(/\*/g, "").replace(LABEL_UNIT_RE, "");
  if (!out.startsWith("…")) out = out.replace(LEADING_CITATION_KEY_RE, "").replace(LEADING_URL_TAIL_RE, "");
  return out.replace(BARE_URL_RE, "").replace(/\s+/g, " ").trim();
}
const TRAILING_OK_RE = /[.!?"”»…]$/;
const LEADING_OK_RE = /^[A-Za-z0-9"'“‘«(…]/;

/** The window text made presentable and idempotent (running it twice changes nothing): stripped to a fixed point, an ellipsis where it opens or ends mid-sentence. */
export function normalizeObligationText(raw: unknown, opts: { dateSpan?: string } = {}): string {
  let t = typeof raw === "string" ? raw : "";
  if (!t) return "";
  const dateSpan = typeof opts?.dateSpan === "string" ? opts.dateSpan : undefined;
  for (let i = 0; i < 6; i += 1) {
    const before = t;
    t = stripOnePass(t, dateSpan);
    if (t === before) break;
  }
  if (!t) return "…";
  if (!LEADING_OK_RE.test(t)) {
    t = t.replace(/^[^A-Za-z0-9"'“‘«(…]+/, "");
    t = t ? `…${t}` : "…";
  } else if (/^[a-z]/.test(t)) t = `…${t}`;
  if (!TRAILING_OK_RE.test(t)) t = `${t.replace(/[;,:]+$/, "").trim()}…`;
  return t;
}

const RECORD_FACTS_GENERIC_RE = /^\[[a-z][a-z0-9_]*\]\s+The captured source states, verbatim: /i;
const RECORD_FACTS_DUE_DATE_RE = /^\[due_date\]\s+The captured source states a due date(?:\s*\(date_precision:\s*(?:day|month|quarter|year)\))?,\s*verbatim: /i;
const RECORD_FACTS_BINDING_POSITION_RE = /^\[binding_position\]\s+The captured source's own applicability language places this item at /i;
// A GAP line is `[slot] <absence token>` (MINT-1); the sentence form is read until the backfill reports zero.
const RECORD_FACTS_GAP_RE = new RegExp(String.raw`^\[[a-z][a-z0-9_]*\]\s+(?:${ABSENCE_TOKEN}\s*$|(?:No verbatim [\s\S]*?\.|[\s\S]*?applicability language[\s\S]*?\.)\s*A full-brief regrounding will re-examine this gap when this item upgrades from record to brief\.?)`, "i");

function findGuillemetPairs(text: string): { start: number; end: number }[] {
  const stack: number[] = [];
  const pairs: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "«") stack.push(i);
    else if (text[i] === "»" && stack.length) pairs.push({ start: stack.pop() as number, end: i });
  }
  return pairs;
}
function findStraightQuotePairs(text: string): { start: number; end: number }[] {
  const pairs: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/"([^"]*)"/g)) pairs.push({ start: m.index as number, end: (m.index as number) + m[0].length - 1 });
  return pairs;
}

/** A record-facts FACT wrapper to the quoted passage that contains the date; a GAP wrapper (no quoted date) is skipped; anything else is not a wrapper (null). */
function unwrapRecordFactsTemplate(windowed: unknown, relDateStart: number, relDateEnd: number): { skip: string } | { passage: string } | null {
  const t = typeof windowed === "string" ? windowed : "";
  if (!SLOT_MARKER_AT_RE.test(t)) return null;
  if (RECORD_FACTS_GAP_RE.test(t)) return { skip: "record_facts_gap_boilerplate_no_quoted_date" };
  if (!(RECORD_FACTS_GENERIC_RE.test(t) || RECORD_FACTS_DUE_DATE_RE.test(t) || RECORD_FACTS_BINDING_POSITION_RE.test(t))) return null;
  const g = findGuillemetPairs(t);
  const pairs = g.length ? g : findStraightQuotePairs(t);
  let best: { start: number; end: number } | null = null;
  for (const p of pairs) if (p.start < relDateStart && relDateEnd <= p.end && (!best || p.end - p.start < best.end - best.start)) best = p;
  return best ? { passage: t.slice(best.start + 1, best.end) } : { skip: "record_facts_template_date_not_in_quote" };
}

/** The clause around [start, end) of `text`: its display text, or a skip reason when it is a GAP wrapper or the date is outside the quoted passage. */
export function clauseAround(text: string, start: number, end: number, maxBefore: number = DEFAULT_MAX_BEFORE, maxAfter: number = DEFAULT_MAX_AFTER, dateSpan?: string): { text: string } | { skip: string } {
  const { pos: from, fragment } = clauseStart(text, start, maxBefore);
  let to = Math.min(text.length, end + maxAfter);
  const tail = text.slice(end, to);
  const termMatch = tail.match(/[.!?»](?!\d)/);
  const termIdx = termMatch ? (termMatch.index as number) + 1 : Infinity;
  const markerMatch = tail.match(SLOT_MARKER_ANYWHERE_RE);
  const markerIdx = markerMatch ? (markerMatch.index as number) : Infinity;
  const cut = Math.min(termIdx, markerIdx);
  if (cut !== Infinity) to = end + cut;
  const raw = text.slice(from, to);
  const relDateEnd = end - from;
  const relDateStart = relDateEnd - (typeof dateSpan === "string" ? dateSpan.length : 0);
  const unwrap = unwrapRecordFactsTemplate(raw, relDateStart, relDateEnd);
  if (unwrap && "skip" in unwrap) return { skip: unwrap.skip };
  if (unwrap && "passage" in unwrap) return { text: normalizeObligationText(unwrap.passage.replace(/\s+/g, " ").trim(), dateSpan === undefined ? {} : { dateSpan }) };
  let windowed = raw.replace(/\s+/g, " ").trim();
  if (fragment && windowed) windowed = `…${windowed}`;
  return { text: normalizeObligationText(windowed, dateSpan === undefined ? {} : { dateSpan }) };
}
