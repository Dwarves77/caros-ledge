// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 637-844)
// The trigger rules of the extractor as DATA (data/rules.json: 20 rules in four kind families plus the two Portuguese phase rules, the two candidate-only
// rules, the deontic and aim patterns, the commencement and status-only patterns), compiled once. A date becomes an event only after a trigger phrase
// is followed by a parseable date; kind is never guessed. The refusal predicates and their reasons live here too.
import { z } from "zod";

import type { EventKind } from "../kinds";

import raw from "./data/rules.json";

const re = z.object({ source: z.string(), flags: z.string() });
const rule = z.object({
  name: z.string(),
  kind: z.string(),
  scanRe: re,
  bareYear: z.boolean().optional(),
  phaseOverride: z.boolean().optional(),
  windowEnd: z.boolean().optional(),
  requireTrailing: re.optional(),
  requireWordWithin: z.object({ re, chars: z.number() }).optional(),
  requireDeonticWithin: z.number().optional(),
  requireDeonticOrAimWithin: z.number().optional(),
});
const file = z.object({ rules: z.array(rule), candidateOnly: z.array(rule), patterns: z.object({ DEONTIC: re, AIM_WORDS: re, COMMENCEMENT_CLAUSE_RE: re, STATUS_ONLY_RE: re }) }).parse(raw);
const compile = (r: z.infer<typeof re>): RegExp => new RegExp(r.source, r.flags);

export interface Rule {
  name: string;
  kind: EventKind;
  scanRe: RegExp;
  bareYear: boolean;
  phaseOverride: boolean;
  windowEnd: boolean;
  requireTrailing: RegExp | null;
  requireWordWithin: { re: RegExp; chars: number } | null;
  requireDeonticWithin: number | null;
  requireDeonticOrAimWithin: number | null;
}
const build = (r: z.infer<typeof rule>): Rule => ({
  name: r.name, kind: r.kind as EventKind, scanRe: compile(r.scanRe), bareYear: r.bareYear === true, phaseOverride: r.phaseOverride === true, windowEnd: r.windowEnd === true,
  requireTrailing: r.requireTrailing ? compile(r.requireTrailing) : null, requireWordWithin: r.requireWordWithin ? { re: compile(r.requireWordWithin.re), chars: r.requireWordWithin.chars } : null,
  requireDeonticWithin: r.requireDeonticWithin ?? null, requireDeonticOrAimWithin: r.requireDeonticOrAimWithin ?? null,
});
export const RULES: readonly Rule[] = file.rules.map(build);
export const CANDIDATE_ONLY_RULES: readonly Rule[] = file.candidateOnly.map(build);
export const DEONTIC = compile(file.patterns.DEONTIC);
export const AIM_WORDS = compile(file.patterns.AIM_WORDS);
const COMMENCEMENT_CLAUSE_RE = compile(file.patterns.COMMENCEMENT_CLAUSE_RE);
const STATUS_ONLY_RE = compile(file.patterns.STATUS_ONLY_RE);

export const REFERENCE_DATE_SKIP_REASON = "date equals a reference date (the run date or the brief's own document date) with no instrument-commencement language in its clause -- refused as a fabricated event, never a real obligation";
export const STATUS_ONLY_SKIP_REASON = "'as of'/'since' clause is only a status/snapshot phrase once its own date span is removed (e.g. \"in force as of\", \"updated as of\") -- never a bound obligation, regardless of any deontic clause nearby";

/** A date equal to the run date or the brief's own document date with no commencement verb in its clause is not an event. */
export function refuseForReferenceDate(iso: string, clauseText: unknown, referenceDates: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(referenceDates) || referenceDates.length === 0 || !referenceDates.includes(iso)) return false;
  return !COMMENCEMENT_CLAUSE_RE.test(typeof clauseText === "string" ? clauseText : "");
}
/** A clause that is only "in force as of" / "updated as of" once its own date span is removed. */
export function isStatusOnlyClause(clauseText: unknown, dateSpan: unknown): boolean {
  const text = typeof clauseText === "string" ? clauseText : "";
  return STATUS_ONLY_RE.test(typeof dateSpan === "string" && dateSpan ? text.replace(dateSpan, "") : text);
}
