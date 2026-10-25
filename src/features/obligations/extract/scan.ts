// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 850-1166)
// The text scan: every rule's trigger followed by a parseable date becomes a hit (with its kind and display window) or a skip WITH A REASON; the
// candidate-only rules (as of, since) become events only when a deontic clause follows and the clause is not a status phrase. One `emit` decides hit or
// skip for all three paths (the old loop copied it three times). Also the due-date slot helpers: the finer of the extractor's and the slot's precision wins
// (never quarter), and a slot span with no event of its own is rescued by re-scanning the capture text around the span.
import { isBindingInstrumentType, type EventKind } from "../kinds";

import { tryParseDateAt, tryParseDateOrBareYearAt, type DateMatch } from "./date-grammar";
import { AIM_WORDS, AWAITING_REGULATION, CANDIDATE_ONLY_RULES, DELEGATED_ACT, DEONTIC, GUIDANCE_EXPECTED, IMPLEMENTING_ACT, isStatusOnlyClause, refuseForReferenceDate, REFERENCE_DATE_SKIP_REASON, REGULATOR_ACTION, REGULATOR_SUBJECT, RULES, STATUS_ONLY_SKIP_REASON, type Rule } from "./rules";
import { clauseAround, sentenceStart } from "./window";

export interface Hit {
  ruleName: string;
  kind: EventKind;
  iso: string;
  precision: "day" | "month" | "year";
  spanStart: number;
  spanEnd: number;
  dateSpan: string;
  obligationText: string;
}
export interface ScanSkip {
  reason: string;
  span: string;
}
export interface ScanResult {
  hits: Hit[];
  skips: ScanSkip[];
}

const findTrailingForClause = (text: string, pos: number): boolean => /^\s*,?\s*for\s+[a-z]/i.test(text.slice(pos, pos + 60));
const PERIOD_RE = /\b(transitional|transition|phase-?in|grace)\s+period\b/i;
const nearPeriodLanguage = (text: string, start: number, end: number): boolean => PERIOD_RE.test(text.slice(Math.max(0, start - 60), end + 20));
function findTrailingToDate(text: string, pos: number): { parsed: DateMatch; matchStart: number } | null {
  const m = text.slice(pos, pos + 8).match(/^\s*(?:to|until)\s+/i);
  if (!m) return null;
  const parsed = tryParseDateAt(text, pos + m[0].length);
  return parsed ? { parsed, matchStart: pos + m[0].length } : null;
}

export function scanText(text: string, options: { referenceDates?: readonly string[]; itemType?: string | null } = {}): ScanResult {
  const referenceDates = options.referenceDates ?? [];
  const bindingAllowed = options.itemType == null ? true : isBindingInstrumentType(options.itemType);
  const hits: Hit[] = [];
  const skips: ScanSkip[] = [];
  const claimed: [number, number][] = [];
  const overlaps = (start: number, end: number): boolean => claimed.some((r) => start < r[1] && end > r[0]);

  /** Window the clause, then either record a hit or a skip with its reason. `statusCheck` adds the status-phrase refusal of the as-of rules. */
  const emit = (ruleName: string, kind: EventKind, parsed: { iso: string; precision: "day" | "month" | "year" }, triggerIdx: number, spanStart: number, spanEnd: number, statusCheck = false): void => {
    const dateSpan = text.slice(spanStart, spanEnd);
    const around = clauseAround(text, triggerIdx, spanEnd, undefined, undefined, dateSpan);
    claimed.push([triggerIdx, spanEnd]);
    if ("skip" in around) skips.push({ reason: around.skip, span: dateSpan });
    else if (refuseForReferenceDate(parsed.iso, around.text, referenceDates)) skips.push({ reason: REFERENCE_DATE_SKIP_REASON, span: dateSpan });
    else if (statusCheck && isStatusOnlyClause(around.text, dateSpan)) skips.push({ reason: STATUS_ONLY_SKIP_REASON, span: dateSpan });
    else hits.push({ ruleName, kind, iso: parsed.iso, precision: parsed.precision, spanStart, spanEnd, dateSpan, obligationText: around.text });
  };

  const scanRule = (rule: Rule): void => {
    rule.scanRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.scanRe.exec(text)) !== null) {
      const afterTrigger = m.index + m[0].length;
      const parsed = rule.bareYear ? tryParseDateOrBareYearAt(text, afterTrigger) : tryParseDateAt(text, afterTrigger);
      if (!parsed) continue;
      const spanStart = afterTrigger + parsed.skip;
      const spanEnd = spanStart + parsed.length;
      if (rule.requireTrailing && !rule.requireTrailing.test(text.slice(spanEnd))) continue;
      if (rule.requireWordWithin && !rule.requireWordWithin.re.test(text.slice(m.index, spanEnd + rule.requireWordWithin.chars))) continue;
      if (rule.requireDeonticWithin && !DEONTIC.test(text.slice(sentenceStart(text, m.index), spanEnd + rule.requireDeonticWithin))) continue;
      if (rule.requireDeonticOrAimWithin) {
        const w = text.slice(sentenceStart(text, m.index), spanEnd + rule.requireDeonticOrAimWithin);
        if (!DEONTIC.test(w) && !AIM_WORDS.test(w)) continue;
      }
      if (overlaps(m.index, spanEnd)) continue;
      let kind = rule.kind;
      const windowText = text.slice(sentenceStart(text, m.index), spanEnd + 220);
      if (rule.name === "by-year-target" || rule.name === "from-year") {
        if (AIM_WORDS.test(windowText)) kind = "target";
        else if (AWAITING_REGULATION.test(windowText)) kind = "guidance_expected";
        else if (DEONTIC.test(windowText)) {
          if (DELEGATED_ACT.test(windowText) && (REGULATOR_SUBJECT.test(windowText) || REGULATOR_ACTION.test(windowText))) kind = "delegated_act_due";
          else if (IMPLEMENTING_ACT.test(windowText) && (REGULATOR_SUBJECT.test(windowText) || REGULATOR_ACTION.test(windowText))) kind = "implementing_act_due";
          else if (REGULATOR_SUBJECT.test(windowText) && REGULATOR_ACTION.test(windowText)) {
            if (GUIDANCE_EXPECTED.test(windowText)) kind = "guidance_expected";
            else kind = "implementing_act_due";
          } else kind = "compliance_deadline";
        } else {
          skips.push({ reason: `date after '${rule.name === "from-year" ? "from" : "by"}' with no deontic ('shall'/'must') or aim/target language nearby — ambiguous whether this is a bound obligation`, span: text.slice(Math.max(0, m.index - 20), spanEnd + 40).trim() });
          continue;
        }
      }
      if (rule.phaseOverride && kind !== "target" && kind !== "implementing_act_due" && kind !== "delegated_act_due" && kind !== "guidance_expected" && (findTrailingForClause(text, spanEnd) || nearPeriodLanguage(text, m.index, spanEnd))) kind = "phase_step";
      if (kind === "compliance_deadline") {
        if (DELEGATED_ACT.test(windowText) && (REGULATOR_SUBJECT.test(windowText) || REGULATOR_ACTION.test(windowText))) {
          kind = "delegated_act_due";
        } else if (IMPLEMENTING_ACT.test(windowText) && (REGULATOR_SUBJECT.test(windowText) || REGULATOR_ACTION.test(windowText))) {
          kind = "implementing_act_due";
        } else if (AWAITING_REGULATION.test(windowText)) {
          kind = "guidance_expected";
        } else if (REGULATOR_SUBJECT.test(windowText) && REGULATOR_ACTION.test(windowText)) {
          if (GUIDANCE_EXPECTED.test(windowText)) kind = "guidance_expected";
          else kind = "implementing_act_due";
        } else if (AIM_WORDS.test(windowText) && !bindingAllowed) {
          kind = "target";
        } else if (!bindingAllowed) {
          skips.push({ reason: "non_binding_instrument_no_compliance_deadline: research, analysis, market-signal and initiative items never receive a compliance_deadline", span: text.slice(Math.max(0, m.index - 20), spanEnd + 40).trim() });
          claimed.push([m.index, spanEnd]);
          continue;
        }
      }
      emit(rule.name, kind, parsed, m.index, spanStart, spanEnd);
      if (rule.windowEnd) {
        const w = findTrailingToDate(text, spanEnd);
        if (w && !overlaps(spanEnd, w.matchStart + w.parsed.length)) {
          const wEnd = w.matchStart + w.parsed.length;
          const before = claimed.length;
          emit(`${rule.name}-window-end`, "other", w.parsed, m.index, w.matchStart, wEnd);
          claimed[before] = [spanEnd, wEnd];
        }
      }
    }
  };
  for (const rule of RULES) scanRule(rule);

  for (const rule of CANDIDATE_ONLY_RULES) {
    rule.scanRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.scanRe.exec(text)) !== null) {
      const afterTrigger = m.index + m[0].length;
      const parsed = tryParseDateOrBareYearAt(text, afterTrigger);
      if (!parsed) continue;
      const spanStart = afterTrigger + parsed.skip;
      const spanEnd = spanStart + parsed.length;
      if (overlaps(m.index, spanEnd)) continue;
      const near = text.slice(Math.max(0, m.index - 20), spanEnd + 20).trim();
      if (/not\s+available/i.test(text.slice(Math.max(0, m.index - 60), m.index))) {
        skips.push({ reason: "'as of'/'since' marks a data-unavailability note on a GAP claim, not an event", span: near });
        claimed.push([m.index, spanEnd]);
        continue;
      }
      if (!DEONTIC.test(text.slice(spanEnd, spanEnd + 200))) {
        skips.push({ reason: `'${rule.name}' marks a status/snapshot date, not a bound obligation (no deontic clause follows)`, span: text.slice(Math.max(0, m.index - 20), spanEnd + 20).trim() });
        claimed.push([m.index, spanEnd]);
        continue;
      }
      emit(rule.name, "other", parsed, m.index, spanStart, spanEnd, true);
    }
  }
  return { hits, skips };
}

// -- due-date slot claims --------------------------------------------------------------------------------------------------------------------------

const DUE_DATE_SLOT_PREFIX = "[due_date] ";
const SLOT_PRECISION_RE = /\(date_precision:\s*(day|month|quarter|year)\)/;
const PRECISION_RANK: Readonly<Record<string, number>> = { year: 1, month: 2, day: 3 };

export interface ClaimIn {
  claim_id: string;
  kind: string;
  text: string;
  span: string | null;
  context?: { before: string; after: string; search_id?: string } | null;
}
export const isDueDateSlotClaim = (claim: { kind?: string; text?: unknown } | null | undefined): boolean => claim?.kind === "FACT" && typeof claim.text === "string" && claim.text.startsWith(DUE_DATE_SLOT_PREFIX);
export function slotDatePrecision(claim: { kind?: string; text?: unknown }): string | null {
  return isDueDateSlotClaim(claim) ? (SLOT_PRECISION_RE.exec(claim.text as string)?.[1] ?? null) : null;
}
/** The finer of the extractor's precision and the slot's (never quarter, never coarser). */
export function finerDuePrecision(extractorPrecision: string, slotPrecision: string | null): string {
  if (slotPrecision === null || !Object.hasOwn(PRECISION_RANK, slotPrecision) || !Object.hasOwn(PRECISION_RANK, extractorPrecision)) return extractorPrecision;
  return (PRECISION_RANK[slotPrecision] as number) > (PRECISION_RANK[extractorPrecision] as number) ? slotPrecision : extractorPrecision;
}

/** A slot span whose own scan found no event is re-scanned with the capture text around it; a hit counts only if its date lies inside the span. */
export function rescueSlotDateWithContext(claimSpan: string, context: { before: string; after: string } | null | undefined, referenceDates: readonly string[], itemType?: string | null): Hit | null {
  if (typeof claimSpan !== "string" || !claimSpan || !context || typeof context.before !== "string" || typeof context.after !== "string") return null;
  const start = context.before.length;
  const { hits } = scanText(context.before + claimSpan + context.after, { referenceDates, ...(itemType !== undefined ? { itemType } : {}) });
  return hits.find((h) => h.spanStart >= start && h.spanEnd <= start + claimSpan.length) ?? null;
}
