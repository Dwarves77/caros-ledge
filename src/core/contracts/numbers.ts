// The ONE number rule beside isVerbatim: the value-preserving numeric view of a text, read through the parse module (the typed figure parser and the locale rule), and the "inside a longer number" test. Grounding (the healer)
// shares it: a figure in the text becomes its exact value and unit, a number with no unit becomes its exact value, both read under the locale of THAT document (INV-298: `1 200 000`, `1,200,000` and `1.200.000` are one
// value, `35,5 %` and `35.5%` are one value; a single `12.345` is a decimal point under the locale of the page that prints it and thousands under another, so two documents of different conventions never fold onto one
// value by accident). A number the parser refuses stays literal and refuses the view; a match may not begin or end inside a longer number. Only a SEARCH is tolerant: a stored span is always a byte-exact slice of the capture (ADR-016).
import { findFigures, interpretNumber, isFigure, resolveLocale, scanNumbers } from "@/core/parse";

export interface Indexed {
  chars: string;
  /** For each output character, where it starts in the original text; one more entry marks the end. */
  map: number[];
}
/**
 * The numeric view of a text. `ends[i]` is where output character i ends in the original text (a folded stretch shares its start and end, so a match that would begin or end inside one is detectable); `refused` names the first
 * thing the parser could not read (an unresolvable locale, an unreadable figure or number): a view with a reason is never used to locate a span.
 */
export interface NumericView extends Indexed {
  ends: number[];
  refused: string | null;
}

/** One output character: compatibility forms (superscript and subscript digits, ligatures) to their plain form, any dash to a hyphen, lower-case. */
const plain = (ch: string): string => ch.normalize("NFKC").replace(/\p{Pd}/gu, "-").toLowerCase();

interface Cut { start: number; end: number; out: string; valueLen: number; valueEnd: number }

/**
 * The numeric-tolerant view of `text`: each typed figure becomes `<exact value> <unit>`, each other number its exact value, everything else lower-cased and whitespace-collapsed. `declared` is the document's
 * number locale (BCP-47) when its capture states one; with none the locale is decided from the text's own numbers. The value of a figure printed without a scale word is positioned at its number, so a bare number
 * ("12,5") finds the number inside "12.5 percent"; a scaled figure ("15 million") is one stretch that a match takes whole or not at all.
 */
export function normalizeNumeric(text: string, declared?: string | null): NumericView {
  const verdict = resolveLocale(text, declared);
  const locale = "reason" in verdict ? null : verdict.locale;
  const cuts: Cut[] = [];
  let refused: string | null = "reason" in verdict ? verdict.reason : null;
  if (locale) {
    for (const h of findFigures(text, { verdict })) {
      if (!isFigure(h.result)) refused ??= `${h.result.literal}: ${h.result.reason}`;
      else {
        const number = scanNumbers(text.slice(h.start, h.end))[0];
        const valueEnd = h.result.scale === null && number ? h.start + number.end : h.end;
        cuts.push({ start: h.start, end: h.end, out: `${h.result.value} ${h.result.unit}`, valueLen: h.result.value.length, valueEnd });
      }
    }
    for (const t of scanNumbers(text)) {
      if (cuts.some((c) => t.start < c.end && t.end > c.start)) continue;
      const r = interpretNumber(t.literal, locale);
      if (r.ok) cuts.push({ start: t.start, end: t.end, out: r.text, valueLen: r.text.length, valueEnd: t.end });
      else refused ??= `${t.literal}: ${r.reason}`;
    }
  }
  cuts.sort((a, b) => a.start - b.start);
  let chars = "";
  const map: number[] = [];
  const ends: number[] = [];
  const push = (s: string, start: number, end: number) => {
    for (const c of s) {
      if (c === " " && chars.endsWith(" ")) {
        ends[ends.length - 1] = end;
        continue;
      }
      chars += c;
      map.push(start);
      ends.push(end);
    }
  };
  let next = 0;
  const copy = (to: number) => {
    for (; next < to; next += 1) push(/\s/.test(text[next] ?? "") ? " " : plain(text[next] ?? ""), next, next + 1);
  };
  for (const c of cuts) {
    copy(c.start);
    push(c.out.slice(0, c.valueLen), c.start, c.valueEnd);
    push(c.out.slice(c.valueLen), c.valueEnd, c.end);
    next = c.end;
  }
  copy(text.length);
  map.push(text.length);
  return { chars, map, ends, refused };
}

/** True when [from, to) of `text` begins or ends inside a longer number (`345` in `12,345`, `12` in `12.5`): a match there would ground a DIFFERENT value (INV-298). */
export function insideLongerNumber(text: string, from: number, to: number): boolean {
  const digit = (c: string | undefined) => c !== undefined && /\d/.test(c);
  const sep = (c: string | undefined) => c === "." || c === ",";
  if (digit(text[from]) && (digit(text[from - 1]) || (sep(text[from - 1]) && digit(text[from - 2])))) return true;
  return digit(text[to - 1]) && (digit(text[to]) || (sep(text[to]) && digit(text[to + 1])));
}
