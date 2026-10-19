// The ONE figure comparator (R2a P2) and the checks that sit beside it. Two figures are equal when they state the same quantity: same kind, same
// qualifiers where both state one, same exact value after the closed unit set's constants. A digit run is read whole by the scanner, so EUR 5
// never backs EUR 50 and EUR 15 million never equals EUR 150 million; there is no substring path and no digit stripping. Gate A (containsToken)
// and S-NUMERIC (detectNumeric) call this and nothing else. Two captures that give two values for one figure DISAGREE: both kept, neither picked.
import { UNIT_FILE } from "./data";
import { absDec, addDec, cmpDec, decToString, halfUlp, mulDec, parseDec, subDec, type Dec } from "./decimal";
import { findFigures, isFigure, type Figure, type ParseOptions } from "./figure";
import { canonicalRatio, kindOf } from "./unit";

export type Comparison = { relation: "equal" } | { relation: "different" } | { relation: "incomparable"; reason: string };
const QUALIFIERS = ["boundary", "gwpSet", "distanceBasis", "massBasis", "scope3Category", "method"] as const;
const dec = (f: Figure): Dec => parseDec(f.value) as Dec;

/** equal / different (same quantity, other value) / incomparable (not the same quantity: another kind, boundary, GWP set, basis or functional unit). */
export function compareFigures(a: Figure, b: Figure): Comparison {
  if (kindOf(a.parts) !== kindOf(b.parts)) return { relation: "incomparable", reason: `${kindOf(a.parts)} is not ${kindOf(b.parts)}` };
  if ((a.functionalUnit ?? "") !== (b.functionalUnit ?? "")) return { relation: "incomparable", reason: "different functional units" };
  for (const q of QUALIFIERS) {
    if (a[q] !== undefined && b[q] !== undefined && a[q] !== b[q]) return { relation: "incomparable", reason: q === "gwpSet" ? "different GWP sets are a series break" : `different ${q}: ${String(a[q])} vs ${String(b[q])}` };
  }
  const x = canonicalRatio(dec(a), a.parts);
  const y = canonicalRatio(dec(b), b.parts);
  return { relation: cmpDec(mulDec(x.num, y.den), mulDec(y.num, x.den)) === 0 ? "equal" : "different" };
}
export const figuresEqual = (a: Figure, b: Figure): boolean => compareFigures(a, b).relation === "equal";

/** Equal to within half a unit of the last published digit of each operand (U6): the tolerance of a golden row against a rounded print. Same unit and kind only. */
export function withinPublishedDigit(a: Figure, b: Figure): boolean {
  if (a.unit !== b.unit || kindOf(a.parts) !== kindOf(b.parts)) return false;
  return cmpDec(absDec(subDec(dec(a), dec(b))), addDec(halfUlp({ n: 0n, s: a.decimals }), halfUlp({ n: 0n, s: b.decimals }))) <= 0;
}

/** Does `haystack` state a figure equal to `figure`? Every number in the haystack is read whole by the scanner, in the haystack's own locale. */
export function stateFigure(haystack: string, figure: Figure, opts: ParseOptions = {}): boolean {
  return findFigures(haystack, opts).some((h) => isFigure(h.result) ? figuresEqual(h.result, figure) : false);
}

/** A non-figure token (a date, a year) found in `haystack` at a numeral boundary on both sides: "2025" is not inside "20250" or "2025/1735", "30 June 2025" is not inside "130 June 2025". */
export function containsNumeral(haystack: string, token: string): boolean {
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
  const t = flat(token);
  if (!t) return false;
  const body = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?<![\\p{N}][.,/])${body}(?![\\p{L}\\p{N}])(?![.,/]\\p{N})`, "iu").test(flat(haystack));
}

export interface Observation { subject: string; figure: Figure; document: string; date: string }
export type Reconciled =
  | { subject: string; state: "agree"; figure: Figure; observations: Observation[] }
  | { subject: string; state: "disagree" | "incomparable"; observations: Observation[]; reason: string };
/** Group captures by the figure they state. Equal values agree; two values for one figure DISAGREE with every observation kept (document and date); the later is never picked (T18). */
export function reconcile(observations: readonly Observation[]): Reconciled[] {
  const bySubject = new Map<string, Observation[]>();
  for (const o of observations) bySubject.set(o.subject, [...(bySubject.get(o.subject) ?? []), o]);
  return [...bySubject].map(([subject, obs]) => {
    const first = obs[0] as Observation;
    const rel = obs.slice(1).map((o) => compareFigures(first.figure, o.figure));
    const bad = rel.find((r) => r.relation !== "equal");
    if (!bad) return { subject, state: "agree" as const, figure: first.figure, observations: obs };
    return { subject, state: bad.relation === "different" ? ("disagree" as const) : ("incomparable" as const), observations: obs, reason: bad.relation === "incomparable" ? bad.reason : `${new Set(obs.map((o) => o.figure.value)).size} values for ${subject}` };
  });
}

export type Verdict = { ok: true } | { ok: false; reason: string };
/** WTT + TTW = WTW within the last published digit of the three operands (U4), as printed decimal strings with their decimals. */
export function boundarySumWithin(wtt: { value: string; decimals: number }, ttw: { value: string; decimals: number }, wtw: { value: string; decimals: number }): Verdict {
  const [a, b, c] = [wtt, ttw, wtw].map((x) => parseDec(x.value)) as [Dec, Dec, Dec];
  const tol = [wtt, ttw, wtw].map((x) => halfUlp({ n: 0n, s: x.decimals })).reduce(addDec);
  const gap = absDec(subDec(c, addDec(a, b)));
  return cmpDec(gap, tol) <= 0 ? { ok: true } : { ok: false, reason: `WTT ${wtt.value} + TTW ${ttw.value} does not give WTW ${wtw.value} within the last published digit` };
}
/** The three boundary figures of one factor: stated as WTT, TTW and WTW, one unit, summing within the last digit, or the figure is withheld. */
export function checkBoundaries(wtt: Figure, ttw: Figure, wtw: Figure): Verdict {
  const stated = [wtt.boundary, ttw.boundary, wtw.boundary].join("/");
  if (stated !== "WTT/TTW/WTW") return { ok: false, reason: `boundaries must be stated as WTT, TTW and WTW; got ${stated}` };
  if (new Set([wtt.unit, ttw.unit, wtw.unit]).size !== 1) return { ok: false, reason: "WTT, TTW and WTW are in different units: convert first" };
  return boundarySumWithin(wtt, ttw, wtw);
}
/** A JS number as the shortest decimal string that prints it (never exponent form), with its decimals: how a stored factor enters the boundary check. */
export function numberAsPrinted(n: number): { value: string; decimals: number } {
  const text = /e/i.test(String(n)) ? n.toFixed(20).replace(/0+$/, "") : String(n);
  return { value: text, decimals: (text.split(".")[1] ?? "").length };
}

export interface WorkedExample { factor: Figure; quantities: Figure[]; result: Figure }
export type ExampleVerdict = { ok: true; sourceUnitDefect: boolean; resolvedKind: string; reasons: string[] } | { ok: false; reason: string };
/** A worked example whose arithmetic holds but whose printed unit contradicts it (T2 TEU-km for tonne-km; T3 a per-dollar unit on a total): resolved by the arithmetic and FLAGGED source_unit_defect (U7). */
export function checkWorkedExample(ex: WorkedExample): ExampleVerdict {
  const product = [ex.factor, ...ex.quantities].map(dec).reduce(mulDec);
  const result = dec(ex.result);
  const tol = [ex.factor, ...ex.quantities, ex.result].map((f) => halfUlp({ n: 0n, s: f.decimals })).reduce(addDec);
  if (cmpDec(absDec(subDec(product, result)), tol) > 0) return { ok: false, reason: "the printed arithmetic does not reproduce the printed result" };
  const dims = ex.quantities.map((q) => (q.parts.d ? kindOf(q.parts) : kindOf({ n: q.parts.n }))).sort();
  const basis = UNIT_FILE.activities.find((a) => [...a.dims].sort().join() === dims.join())?.activity ?? (dims.length === 1 ? dims[0] : undefined);
  const reasons: string[] = [];
  const factorDim = ex.factor.parts.d ? kindOf({ n: ex.factor.parts.d }) : undefined;
  const resolvedKind = `${ex.factor.parts.gas ? `emission:${ex.factor.parts.gas}` : "mass"}/${basis ?? factorDim ?? ""}`;
  if (basis && factorDim && basis !== factorDim) reasons.push(`the factor's printed basis is ${factorDim} but the quantities multiplied are ${basis}`);
  if (ex.result.parts.d) reasons.push("the result is printed with a per-unit basis but is a total");
  return { ok: true, sourceUnitDefect: reasons.length > 0, resolvedKind, reasons };
}

/** Stored factor numbers carry no printed precision, so WTT + TTW = WTW is checked EXACTLY on their shortest decimal spellings (no float epsilon: 0.1 + 0.2 is 0.3). */
export function numbersSumExactly(wtt: number, ttw: number, wtw: number): { ok: boolean; sum: string } {
  const [a, b, c] = [wtt, ttw, wtw].map((n) => parseDec(numberAsPrinted(n).value)) as [Dec, Dec, Dec];
  const sum = addDec(a, b);
  return { ok: cmpDec(sum, c) === 0, sum: decToString(sum) };
}
