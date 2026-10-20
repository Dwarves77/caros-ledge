// The ONE figure comparator (R2a P2). Two figures are equal when they state the same quantity: same kind, same functional unit, same qualifiers where both state
// one, same exact value after the closed unit set's constants. A digit run is read whole by the scanner, so EUR 5 never backs EUR 50 and EUR 15 million never equals
// EUR 150 million; there is no substring path and no digit stripping. Gate A (containsToken) and S-NUMERIC (detectNumeric) call this and nothing else.
import { cmpDec, mulDec, parseDec, type Dec } from "./decimal";
import { findFigures, isFigure, type Figure, type ParseOptions } from "./figure";
import { canonicalRatio, kindOf } from "./unit";

const QUALIFIERS = ["boundary", "gwpSet", "distanceBasis", "massBasis", "scope3Category", "method"] as const;
const dec = (f: Figure): Dec => parseDec(f.value) as Dec;

/** The same quantity at the same value: another kind, functional unit, boundary, GWP set or basis is a different quantity, never equal. */
export function figuresEqual(a: Figure, b: Figure): boolean {
  if (kindOf(a.parts) !== kindOf(b.parts) || (a.functionalUnit ?? "") !== (b.functionalUnit ?? "")) return false;
  if (QUALIFIERS.some((q) => a[q] !== undefined && b[q] !== undefined && a[q] !== b[q])) return false;
  const x = canonicalRatio(dec(a), a.parts);
  const y = canonicalRatio(dec(b), b.parts);
  return cmpDec(mulDec(x.num, y.den), mulDec(y.num, x.den)) === 0;
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

