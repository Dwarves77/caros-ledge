// The typed figure parser (R2a P1): text in, a typed figure out, or a REFUSAL with the reason, or a typed MISSING value; never a guess and never a zero.
// A figure carries its literal, its exact decimal value (scale applied), its unit and kind, the significant digits the source printed, and the
// qualifiers the source states beside it: boundary (WTW/WTT/TTW), GWP set, distance and mass basis, Scope 3 category, method, hub kind, framework.
// Locale is decided once per document (locale.ts); the unit set, scales and qualifier phrases are data (./data).
import { LOCALES, MINUS_CLASS, QUALIFIER_FILE, SCALE_ALTERNATION, SCALE_BY_WORD } from "./data";
import { decToString, parseDec, shiftDec, sigDigitsOf, type Dec } from "./decimal";
import { interpretNumber, resolveLocale, scanNumbers, type Interpreted, type LocaleVerdict, type NumberToken } from "./locale";
import { kindOf, matchUnit, moneyBefore, type UnitParts } from "./unit";

export interface Figure {
  literal: string;
  /** exact decimal string with the scale word applied ("15 million" is "15000000") */
  value: string;
  unit: string;
  scale: string | null;
  /** significant digits the source printed; a display helper never prints more */
  sigDigits: number;
  decimals: number;
  kind: string;
  parts: UnitParts;
  locale: string;
  functionalUnit?: string;
  boundary?: string;
  gwpSet?: string;
  distanceBasis?: string;
  massBasis?: string;
  scope3Category?: number;
  method?: string;
  hubKind?: string;
  framework?: string;
  /** a spend-based figure is screening grade by rule, not by an editor */
  screeningGrade?: boolean;
}
/** `unreadable` marks a figure that IS there but cannot be read (an ambiguous number, a mixed convention), against text that has no figure at all. */
export interface Refusal { refused: true; reason: string; literal: string; unreadable?: true }
export interface Missing { missing: string; literal: string }
export type Parsed = Figure | Refusal | Missing;
export interface Hit { start: number; end: number; result: Figure | Refusal }
/** `locale` is a declared document locale; `verdict` is a verdict already reached for the WHOLE document (so a line of it is never judged alone). */
export interface ParseOptions { locale?: string | null; verdict?: LocaleVerdict; /** a table that declares what a token means (the IMO dash is "not_set") overrides the data default for that literal */ missingAs?: Record<string, string> }

export const isFigure = (p: Parsed): p is Figure => "value" in p;

const SCALE = new RegExp(`^\\s?(?<sc>${SCALE_ALTERNATION})(?![A-Za-z0-9])`, "i");
const MINUS_BEFORE = new RegExp(`(?:^|[\\s(])[${MINUS_CLASS}]$`);
const QUALIFIED_DIMS = new Set(QUALIFIER_FILE.qualifiedDims);
const FIELDS = Object.entries(QUALIFIER_FILE.fields).map(([field, values]) => ({ field, values: Object.entries(values).map(([value, pats]) => ({ value, re: new RegExp(pats.join("|"), "gi") })) }));

/** Read one literal under the document's locale verdict; with no verdict a literal reads only when every locale agrees on its value. */
function read(literal: string, v: LocaleVerdict): Interpreted {
  if (!("reason" in v)) return interpretNumber(literal, v.locale);
  const reads = Object.keys(LOCALES).map((l) => interpretNumber(literal, l)).filter((r) => r.ok);
  const first = reads[0];
  return first && reads.every((r) => r.ok && r.text === first.text) ? first : { ok: false, reason: "reason" in v ? v.reason : "no locale" };
}

function figureAt(text: string, tok: NumberToken, verdict: LocaleVerdict): Hit | null {
  const before = text.slice(0, tok.start);
  const money = moneyBefore(before);
  if (!money && /[A-Za-z]$/.test(before)) return null;
  const negative = MINUS_BEFORE.test(before);
  for (const lit of [...new Set([tok.literal, tok.base])]) {
    const end = tok.start + lit.length;
    const scale = SCALE.exec(text.slice(end));
    const afterScale = end + (scale ? scale[0].length : 0);
    const lead = /^\s?/.exec(text.slice(afterScale))?.[0].length ?? 0;
    const um = money ? null : matchUnit(text.slice(afterScale + lead));
    if (!money && !um) continue;
    const stop = money ? afterScale : afterScale + lead + (um?.length ?? 0);
    const start = tok.start - (money?.length ?? 0) - (negative ? 1 : 0);
    const literal = text.slice(start, stop);
    const refuse = (reason: string): Hit => ({ start, end: stop, result: { refused: true, reason, literal, unreadable: true } });
    if (money && /^[A-Za-z]/.test(text.slice(stop))) return refuse("a scale or unit suffix after a currency amount is not in the closed set");
    const num = read(lit, verdict);
    if (!num.ok) {
      if (lit !== tok.base) continue;
      return refuse(num.reason);
    }
    const parts: UnitParts = money ? { n: money.unit } : (um as NonNullable<typeof um>).parts;
    const exp = scale?.groups?.sc ? SCALE_BY_WORD.get(scale.groups.sc.toLowerCase())?.exp : undefined;
    const dec = parseDec(`${negative ? "-" : ""}${num.text}`) as Dec;
    const figure: Figure = {
      literal, value: decToString(exp ? shiftDec(dec, exp) : dec), unit: money ? money.unit : (um as NonNullable<typeof um>).unit, scale: scale?.groups?.sc?.toLowerCase() ?? null,
      sigDigits: sigDigitsOf(lit), decimals: num.decimals, kind: money ? kindOf(parts) : (um as NonNullable<typeof um>).kind, parts, locale: "reason" in verdict ? "" : verdict.locale,
      ...(um?.functionalUnit ? { functionalUnit: um.functionalUnit } : {}),
    };
    return { start, end: stop, result: figure };
  }
  return null;
}

/** The value of `field` stated nearest the figure inside its window (between the neighbouring numbers, at most the data's window); two different values at one distance state nothing. */
function nearest(text: string, hit: Hit, prevEnd: number, nextStart: number, field: (typeof FIELDS)[number]): string | undefined {
  const max = QUALIFIER_FILE.window.max;
  const from = Math.max(prevEnd, hit.start - max, text.lastIndexOf("\n", hit.start) + 1);
  const nl = text.indexOf("\n", hit.end);
  const to = Math.min(nextStart, hit.end + max, nl < 0 ? text.length : nl);
  const win = text.slice(from, to);
  const [s, e] = [hit.start - from, hit.end - from];
  let best: { value: string; dist: number } | undefined;
  let tie = false;
  for (const v of field.values) {
    for (const m of win.matchAll(v.re)) {
      const stopAt = m.index + m[0].length;
      const dist = stopAt <= s ? s - stopAt : m.index >= e ? m.index - e : 0;
      if (!best || dist < best.dist) { best = { value: v.value, dist }; tie = false; }
      else if (dist === best.dist && v.value !== best.value) tie = true;
    }
  }
  return best && !tie ? best.value : undefined;
}

/** The one framework (and version) the text names, e.g. "GLEC 3.0"; none when it names two. */
function frameworkOf(text: string): string | undefined {
  const found = new Set<string>();
  for (const f of QUALIFIER_FILE.frameworks) for (const m of text.matchAll(new RegExp(f.pattern, "gi"))) found.add(m.groups?.version ? `${f.id} ${m.groups.version}` : f.id);
  return found.size === 1 ? [...found][0] : undefined;
}

/** Every figure in `text`, in order. A document whose number convention cannot be resolved yields refusals for the literals that depend on it. */
export function findFigures(text: string, opts: ParseOptions = {}): Hit[] {
  const verdict = opts.verdict ?? resolveLocale(text, opts.locale);
  const tokens = scanNumbers(text);
  const hits: Hit[] = [];
  for (const tok of tokens) {
    if (hits.some((h) => tok.start >= h.start && tok.start < h.end)) continue;
    const hit = figureAt(text, tok, verdict);
    if (hit) hits.push(hit);
  }
  const framework = frameworkOf(text);
  for (const hit of hits) {
    const r = hit.result;
    if (!("value" in r) || !(r.parts.gas || r.parts.d || QUALIFIED_DIMS.has(r.kind))) continue;
    const prevEnd = Math.max(0, ...hits.filter((o) => o.end <= hit.start).map((o) => o.end));
    const nextStart = Math.min(text.length, ...hits.filter((o) => o.start >= hit.end).map((o) => o.start));
    const q = r as unknown as Record<string, unknown>;
    for (const f of FIELDS) {
      const v = nearest(text, hit, prevEnd, nextStart, f);
      if (v !== undefined) q[f.field] = f.field === "scope3Category" ? Number(v) : v;
    }
    if (r.method && QUALIFIER_FILE.screeningGrade.includes(r.method)) r.screeningGrade = true;
    if (framework) r.framework = framework;
  }
  return hits;
}

