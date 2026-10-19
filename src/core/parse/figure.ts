// The typed figure parser (R2a P1): text in, a typed figure out, or a REFUSAL with the reason, or a typed MISSING value; never a guess and never a zero.
// A figure carries its literal, its exact decimal value (scale applied), its unit and kind, the significant digits the source printed, and the
// qualifiers the source states beside it: boundary (WTW/WTT/TTW), GWP set, distance and mass basis, Scope 3 category, method, hub kind, framework.
// Locale is decided once per document (locale.ts); the unit set, scales and qualifier phrases are data (./data).
import { LOCALES, MINUS_CLASS, MISSING_FILE, QUALIFIER_FILE, SCALE_ALTERNATION, SCALE_BY_WORD, UNIT_BY_ID } from "./data";
import { decToString, parseDec, roundSig, shiftDec, sigDigitsOf, type Dec } from "./decimal";
import { formatNumber, interpretNumber, resolveLocale, scanNumbers, type Interpreted, type LocaleVerdict, type NumberToken } from "./locale";
import { displayOf, kindOf, labelOf, matchUnit, moneyBefore, unitString, type UnitParts } from "./unit";

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
export interface Refusal { refused: true; reason: string; literal: string }
export interface Missing { missing: string; literal: string }
export type Parsed = Figure | Refusal | Missing;
export interface Hit { start: number; end: number; result: Figure | Refusal }
/** `locale` is a declared document locale; `verdict` is a verdict already reached for the WHOLE document (so a line of it is never judged alone). */
export interface ParseOptions { locale?: string | null; verdict?: LocaleVerdict; /** a table that declares what a token means (the IMO dash is "not_set") overrides the data default for that literal */ missingAs?: Record<string, string> }

export const isFigure = (p: Parsed): p is Figure => "value" in p;
export const isRefusal = (p: Parsed): p is Refusal => "refused" in p;

const SCALE = new RegExp(`^\\s?(?<sc>${SCALE_ALTERNATION})(?![A-Za-z0-9])`, "i");
const MINUS_BEFORE = new RegExp(`(?:^|[\\s(])[${MINUS_CLASS}]$`);
const MISSING = new Map(MISSING_FILE.tokens.map((t) => [t.literal, t.kind] as const));
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
    const refuse = (reason: string): Hit => ({ start, end: stop, result: { refused: true, reason, literal } });
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

/** One figure from one cell or sentence: a typed missing value ("TBM", "N/A", a dash, "not_set", "M"), a figure, or a refusal naming why not. */
export function parseFigure(text: string, opts: ParseOptions = {}): Parsed {
  const t = text.trim();
  const miss = opts.missingAs?.[t] ?? MISSING.get(t);
  if (miss) return { missing: miss, literal: t };
  const hits = findFigures(t, opts);
  const first = hits[0];
  if (!first) return { refused: true, reason: "no figure with a unit from the closed set", literal: t };
  if (hits.length > 1) return { refused: true, reason: `${hits.length} figures in one cell: parse one figure at a time`, literal: t };
  return first.result;
}

/** What a writer may store for a parsed cell: a missing value is NULL with its kind, never "0"; a refusal stores nothing. */
export function storedValue(p: Parsed): { value: string | null; unit: string | null; missing: string | null } | null {
  if (isRefusal(p)) return null;
  if ("missing" in p) return { value: null, unit: null, missing: p.missing };
  return { value: p.value, unit: p.unit, missing: null };
}

/** `value` printed with at most `sig` significant digits (the source's own precision), grouped for `localeId`. Never more digits than the source printed. */
export function displayValue(value: string, sig: number, localeId: string): string {
  const d = parseDec(value) as Dec;
  return formatNumber(decToString(roundSig(d, sig)), localeId);
}
export function displayFigure(f: Figure, localeId: string): string {
  const num = displayValue(f.value, f.sigDigits, localeId);
  const label = `${labelOf(f.parts.n)}${f.parts.gas ? ` ${f.parts.gas}` : ""}${f.parts.d ? `/${labelOf(f.parts.d)}` : ""}`;
  const style = displayOf(f.parts.n);
  return style === "prefix" ? `${label} ${num}` : style === "tight" ? `${num}${label}` : `${num} ${label}`;
}

export interface PhaseIn { emissions_year: number; surrender_year: number; share: string; literal: string }
/** Phase-ins typed with their three roles (U11). A bare "100% from 2026" names no role for its year, so it is refused, not read as either. */
export function parsePhaseIn(text: string, opts: ParseOptions = {}): { entries: PhaseIn[]; refused: Refusal[] } {
  const verdict = resolveLocale(text, opts.locale);
  const entries: PhaseIn[] = [];
  const refused: Refusal[] = [];
  const spans: [number, number][] = [];
  const share = (s: string): string | null => {
    const r = verdict.locale ? interpretNumber(s, verdict.locale) : null;
    return r?.ok ? r.text : null;
  };
  for (const m of text.matchAll(new RegExp(QUALIFIER_FILE.phaseIn.pattern, "gi"))) {
    const g = m.groups ?? {};
    const sh = share(g.share ?? "");
    spans.push([m.index, m.index + m[0].length]);
    if (sh === null) refused.push({ refused: true, reason: "phase-in share not readable in the document's number convention", literal: m[0] });
    else entries.push({ emissions_year: Number(g.emissions), surrender_year: Number(g.surrender), share: sh, literal: m[0] });
  }
  for (const m of text.matchAll(new RegExp(QUALIFIER_FILE.phaseIn.bare, "gi"))) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    refused.push({ refused: true, reason: "a phase-in share with one year does not say whether the year is the emissions year or the surrender year", literal: m[0] });
  }
  return { entries, refused };
}

/** A figure built from a stored value and a unit id (a database column, a golden row), so it is compared by the same comparator as one read from prose. */
export function figureOf(value: string, unit: string | UnitParts, extra: Partial<Pick<Figure, "boundary" | "gwpSet" | "functionalUnit">> = {}): Figure | Refusal {
  const parts: UnitParts = typeof unit === "string" ? { n: unit } : unit;
  const dec = parseDec(value);
  if (!dec || !UNIT_BY_ID.has(parts.n) || (parts.d !== undefined && !UNIT_BY_ID.has(parts.d))) return { refused: true, reason: `${value} ${typeof unit === "string" ? unit : unitString(parts)} is not a decimal with a unit from the closed set`, literal: value };
  return { literal: value, value: decToString(dec), unit: unitString(parts), scale: null, sigDigits: sigDigitsOf(value), decimals: dec.s, kind: kindOf(parts), parts, locale: "", ...extra };
}
