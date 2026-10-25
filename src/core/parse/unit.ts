// The closed unit set (U2) and the intensity kinds (U3). Every unit, factor, gas and bridge is data (./data/units.json); this module builds the
// matchers from it and answers three questions: which unit starts here, are two quantities the same kind, and what is one worth in another unit.
// Kinds never convert implicitly: tonne-km is not TEU-km, a per-litre intensity is not a per-MJ one; a cross-kind request is refused, and the
// only bridge between two activity bases is a NAMED data row (tonnes per TEU, with its source), passed explicitly.
import { aliasAlternation, escapeRe, GAS_ALTERNATION, GAS_BY_ALIAS, UNIT_BY_ID, UNIT_FILE, UNITS, unitOfAlias, unitsOfDim, type Unit } from "./data";
import statutoryUnitsJson from "./data/statutory-units.json";
import { mulDec, parseDec, type Dec } from "./decimal";

/** Unit ids of a quantity: a plain unit (n), or a ratio n[ gas]/d. */
export interface UnitParts { n: string; d?: string; gas?: string }
export interface UnitMatch { length: number; unit: string; kind: string; parts: UnitParts; functionalUnit?: string }

const dimOf = (id: string): string => UNIT_BY_ID.get(id)?.dim ?? id;
const factorOf = (id: string): Dec => parseDec(UNIT_BY_ID.get(id)?.factor ?? "1") as Dec;
const ONE: Dec = { n: 1n, s: 0 };

/** The kind of a quantity: its dimension, or numerator-class/denominator-dimension for a ratio. Two quantities of different kind are never equal and never convert. */
export const kindOf = (p: UnitParts): string => {
  const num = p.gas ? `emission:${p.gas}` : dimOf(p.n);
  return p.d ? `${num}/${dimOf(p.d)}` : num;
};
const unitString = (p: UnitParts): string => (p.d ? `${p.n}${p.gas ? ` ${p.gas}` : ""}/${p.d}` : p.n);
/** An amount of money or a share: the figures a trajectory table row (a value per year) is made of. */
export const isTrajectoryUnit = (id: string): boolean => UNIT_BY_ID.get(id)?.trajectory === true;

const NUMERATORS = unitsOfDim(UNIT_FILE.intensity.numeratorDims);
const DENOMINATORS = unitsOfDim(UNIT_FILE.intensity.denominatorDims);
const PER = UNIT_FILE.intensity.perWords.map(escapeRe).join("|");
const COMPOUND = new RegExp(`^(?<core>(?<n>${aliasAlternation(NUMERATORS)})(?:\\s?(?<gas>${GAS_ALTERNATION}))?\\s?(?:\\/|\\s(?:${PER})\\s)\\s?(?<d>${aliasAlternation(DENOMINATORS)})(?![A-Za-z0-9]))(?:(?:\\s+of)?\\s+(?<fu>[A-Za-z][A-Za-z-]*))?`, "i");
const GAS_MASS = new RegExp(`^(?<n>${aliasAlternation(NUMERATORS)})\\s?(?:of\\s+)?(?<gas>${GAS_ALTERNATION})(?![A-Za-z0-9])`, "i");
const SIMPLE = new RegExp(`^(?<u>${aliasAlternation(UNITS)})(?![A-Za-z0-9])`, "i");
const STOP = new Set(UNIT_FILE.intensity.functionalUnitStop);
const gasOf = (text: string): string | undefined => [...GAS_BY_ALIAS].find(([a]) => a.toLowerCase() === text.toLowerCase())?.[1];

/** The unit expression at the start of `rest` (a ratio such as "g CO2e/TEU-km" or "t CO2/t clinker", else one unit), or null. */
export function matchUnit(rest: string): UnitMatch | null {
  const c = COMPOUND.exec(rest);
  const n = c?.groups?.n ? unitOfAlias(c.groups.n) : null;
  const d = c?.groups?.d ? unitOfAlias(c.groups.d) : null;
  if (c?.groups && n && d && NUMERATORS.includes(n) && DENOMINATORS.includes(d)) {
    const gas = c.groups.gas ? gasOf(c.groups.gas) : undefined;
    const fuWord = c.groups.fu?.toLowerCase();
    const fu = UNIT_FILE.intensity.numeratorDims.includes(d.dim) && fuWord && !STOP.has(fuWord) && !unitOfAlias(fuWord) ? fuWord : undefined;
    const parts: UnitParts = { n: n.id, d: d.id, ...(gas ? { gas } : {}) };
    const length = fu ? c[0].length : (c.groups.core ?? "").length;
    return { length, unit: unitString(parts), kind: kindOf(parts), parts, ...(fu ? { functionalUnit: fu } : {}) };
  }
  const g = GAS_MASS.exec(rest);
  const gn = g?.groups?.n ? unitOfAlias(g.groups.n) : null;
  const gas = g?.groups?.gas ? gasOf(g.groups.gas) : undefined;
  if (g && gn && NUMERATORS.includes(gn) && gas) {
    const parts: UnitParts = { n: gn.id, gas };
    return { length: g[0].length, unit: unitString(parts), kind: kindOf(parts), parts };
  }
  const s = SIMPLE.exec(rest);
  const u: Unit | null = s?.groups?.u ? unitOfAlias(s.groups.u) : null;
  return s && u ? { length: s[0].length, unit: u.id, kind: u.dim, parts: { n: u.id } } : null;
}

/** The money unit written directly before a number ("€", "EUR ", "US$"), or null; `before` is the text ahead of the number. */
const MONEY = UNITS.filter((u) => u.money);
const MONEY_PREFIX = new RegExp(`(?:${aliasAlternation(MONEY, "symbols")})\\s?$`, "i");
export function moneyBefore(before: string): { unit: string; length: number } | null {
  const m = MONEY_PREFIX.exec(before.slice(-12));
  const u = m ? unitOfAlias(m[0].trim()) : null;
  // A code is a code only where it starts: the "eur" ending "Valeur" is part of a word.
  const inWord = m ? /[A-Za-z0-9]/.test(before[before.length - m[0].length - 1] ?? "") && /^[A-Za-z]/.test(m[0]) : false;
  return m && u?.money && !inWord ? { unit: u.id, length: m[0].length } : null;
}

/** value * factors of the unit parts, as a numerator and a denominator (cross-multiplied to compare two quantities exactly). */
export const canonicalRatio = (value: Dec, p: UnitParts): { num: Dec; den: Dec } => ({ num: mulDec(value, factorOf(p.n)), den: p.d ? factorOf(p.d) : ONE });



/** The tokens of a unit as stored or as prose: letters and digits starting with a letter (so "2 400" falls away and "tCO2e" stays one token), and the percent sign. */
const unitTokens = (s: string): string[] => s.toLowerCase().replace(/€/g, " eur ").match(/%|\p{L}[\p{L}\p{N}]*/gu) ?? [];
export interface StatutoryForm { form: string; unit: string; exact?: boolean }
const longestFirst = (forms: readonly StatutoryForm[]): StatutoryForm[] => [...forms].sort((a, b) => b.form.length - a.form.length);
const STATUTORY_FORMS = longestFirst(statutoryUnitsJson.forms);

/**
 * The canonical token of a statutory unit written as prose or as a currency-prefixed phrase ("EUR 2 400 per tonne", "EUR per equivalent metric ton of VLSFO", "grams of CO2 equivalent per MJ", "% minimum share of SAF", "EUR/tCO2e"): EUR/t, EUR/tCO2e,
 * EUR/GJ, gCO2e/MJ, pct, EUR, t, MW or months, from the data map in data/statutory-units.json, longest form first. A form marked exact must be the whole unit; the others may sit inside a longer sentence. A unit no form states is null, never guessed.
 * The one map the pattern facts and the statutory derivation share; a caller whose result depends on the map (the pattern facts, under the method-version gate) passes the same file in as `forms` so the gate sees it.
 */
export function statutoryUnit(raw: string | null | undefined, forms: readonly StatutoryForm[] = STATUTORY_FORMS): string | null {
  const tokens = unitTokens(String(raw ?? ""));
  if (!tokens.length) return null;
  const phrase = ` ${tokens.join(" ")} `;
  for (const f of forms === STATUTORY_FORMS ? forms : longestFirst(forms)) if (f.exact ? phrase === ` ${f.form} ` : phrase.includes(` ${f.form} `)) return f.unit;
  return null;
}
