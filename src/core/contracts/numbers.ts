// The ONE number rule beside isVerbatim: the value-preserving numeric fold and the "inside a longer number" test. Grounding (the healer) shares it: a separator folds ONLY when the figure's value is unchanged
// (INV-298: `1 200 000`, `1,200,000` and `1.200.000` are one value; a single `12.345` against `12,345` is ambiguous and never folds), and a tolerant match may not begin or end inside a longer number.
// Only a SEARCH is tolerant: a stored span is always a byte-exact slice of the capture (ADR-016).

export interface Indexed {
  chars: string;
  map: number[];
}
const CODE_OF: Record<string, string> = { "€": "eur", $: "usd", "£": "gbp", "¥": "jpy" };
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUB = "₀₁₂₃₄₅₆₇₈₉";
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "−"]);
const RUN = /\d(?:[., ]\d+)*/g;

/** One run of digits and separators, folded by value: thousands groups drop their separator, a decimal separator becomes `.`, an ambiguous single `,` or `.` stays literal. `offs` maps each output character to its offset in the run. */
function foldRun(run: string): { text: string; offs: number[] } {
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

/** True when [from, to) of `text` begins or ends inside a longer number (`345` in `12,345`, `12` in `12.5`): a match there would ground a DIFFERENT value (INV-298). */
export function insideLongerNumber(text: string, from: number, to: number): boolean {
  const digit = (c: string | undefined) => c !== undefined && /\d/.test(c);
  const sep = (c: string | undefined) => c === "." || c === ",";
  if (digit(text[from]) && (digit(text[from - 1]) || (sep(text[from - 1]) && digit(text[from - 2])))) return true;
  return digit(text[to - 1]) && (digit(text[to]) || (sep(text[to]) && digit(text[to + 1])));
}
