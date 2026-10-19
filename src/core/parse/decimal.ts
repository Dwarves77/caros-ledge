// Exact decimal arithmetic for figures: a value is a BigInt over a power of ten, so "0.890" keeps its three decimals, 0.1 + 0.2 is 0.3
// and no figure passes through a float. Only what the parsers need: parse, compare, add, multiply, divide to a stated precision, round to significant digits.

export interface Dec {
  /** value = n / 10^s; s keeps the decimals the literal printed, trailing zeros included */
  n: bigint;
  s: number;
}

const DEC_RE = /^(-?)(\d+)(?:\.(\d+))?$/;
const pow10 = (e: number): bigint => 10n ** BigInt(e);

export function parseDec(text: string): Dec | null {
  const m = DEC_RE.exec(text.trim());
  if (!m) return null;
  const frac = m[3] ?? "";
  const n = BigInt(`${m[2]}${frac}`);
  return { n: m[1] ? -n : n, s: frac.length };
}

const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
};
export function cmpDec(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function addDec(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return { n: x + y, s };
}
export const subDec = (a: Dec, b: Dec): Dec => addDec(a, { n: -b.n, s: b.s });
export const mulDec = (a: Dec, b: Dec): Dec => ({ n: a.n * b.n, s: a.s + b.s });
export const absDec = (a: Dec): Dec => (a.n < 0n ? { n: -a.n, s: a.s } : a);
/** a times 10^exp (exp >= 0): a scale word such as "million" */
export const shiftDec = (a: Dec, exp: number): Dec => ({ n: a.n * pow10(exp), s: a.s });
/** Half a unit of the last printed digit of a literal: the tolerance of a rounded figure (U6). */
export const halfUlp = (a: Dec): Dec => ({ n: 5n, s: a.s + 1 });

/** a / b truncated to `places` decimals (b must be non-zero); callers round to significant digits afterwards. */
export function divDec(a: Dec, b: Dec, places: number): Dec {
  return { n: (a.n * pow10(b.s + places)) / (b.n * pow10(a.s)), s: places };
}

export function decToString(d: Dec, keepScale = false): string {
  const neg = d.n < 0n;
  const digits = (neg ? -d.n : d.n).toString().padStart(d.s + 1, "0");
  const int = digits.slice(0, digits.length - d.s);
  const frac = digits.slice(digits.length - d.s);
  const shown = keepScale ? frac : frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${shown ? `.${shown}` : ""}`;
}

/** Significant digits of a printed number: from its first non-zero digit to its last digit, trailing zeros counted ("0,890" is 3, "15 000" is 5). */
export const sigDigitsOf = (printed: string): number => Math.max(1, printed.replace(/\D/g, "").replace(/^0+/, "").length);

/** Round half away from zero to `sig` significant digits; a value with fewer digits comes back unchanged. */
export function roundSig(d: Dec, sig: number): Dec {
  const abs = d.n < 0n ? -d.n : d.n;
  const drop = abs.toString().length - sig;
  if (drop <= 0 || abs === 0n) return d;
  const p = pow10(drop);
  let q = abs / p;
  if ((abs % p) * 2n >= p) q += 1n;
  const n = d.n < 0n ? -q : q;
  return d.s >= drop ? { n, s: d.s - drop } : { n: n * pow10(drop - d.s), s: 0 };
}
