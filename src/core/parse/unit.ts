// The closed unit set (U2) and the intensity kinds (U3). Every unit, factor, gas and bridge is data (./data/units.json); this module builds the
// matchers from it and answers three questions: which unit starts here, are two quantities the same kind, and what is one worth in another unit.
// Kinds never convert implicitly: tonne-km is not TEU-km, a per-litre intensity is not a per-MJ one; a cross-kind request is refused, and the
// only bridge between two activity bases is a NAMED data row (tonnes per TEU, with its source), passed explicitly.
import { aliasAlternation, escapeRe, GAS_ALTERNATION, GAS_BY_ALIAS, UNIT_BY_ID, UNIT_FILE, UNITS, unitOfAlias, unitsOfDim, type Unit } from "./data";
import { divDec, mulDec, parseDec, roundSig, type Dec } from "./decimal";

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
export const unitString = (p: UnitParts): string => (p.d ? `${p.n}${p.gas ? ` ${p.gas}` : ""}/${p.d}` : p.n);
export const labelOf = (id: string): string => UNIT_BY_ID.get(id)?.label ?? id;
/** An amount of money or a share: the figures a trajectory table row (a value per year) is made of. */
export const isTrajectoryUnit = (id: string): boolean => UNIT_BY_ID.get(id)?.trajectory === true;
export const displayOf = (id: string): string => UNIT_BY_ID.get(id)?.display ?? "suffix";

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

export type Converted = { ok: true; value: Dec } | { ok: false; reason: string };
/** `value` in unit `from` expressed in unit `to`, kept to `sig` significant digits; refused when the two are not the same kind. */
export function convertValue(value: Dec, from: UnitParts, to: UnitParts, sig: number): Converted {
  if (kindOf(from) !== kindOf(to)) return { ok: false, reason: `${kindOf(from)} is not ${kindOf(to)}: kinds never convert implicitly` };
  const top = mulDec(mulDec(value, factorOf(from.n)), to.d ? factorOf(to.d) : ONE);
  const bottom = mulDec(factorOf(to.n), from.d ? factorOf(from.d) : ONE);
  return { ok: true, value: roundSig(divDec(top, bottom, 40), sig) };
}

const canonId = (dim: string): string => UNITS.find((u) => u.dim === dim && u.factor === "1")?.id ?? "";
/** The one door between a tonne-km and a TEU-km intensity: a named bridge row (tonnes per TEU with its source), never an assumption. */
export function convertViaBridge(value: Dec, from: UnitParts, to: UnitParts, bridgeId: string, sig: number): Converted {
  const bridge = UNIT_FILE.bridges.find((b) => b.id === bridgeId);
  if (!bridge) return { ok: false, reason: `no bridge named ${bridgeId}` };
  if (!from.d || !to.d || from.gas !== to.gas) return { ok: false, reason: "a bridge converts an intensity per activity basis, same gas" };
  const [dFrom, dTo] = [dimOf(from.d), dimOf(to.d)];
  const forward = dFrom === bridge.from && dTo === bridge.to;
  if (!forward && !(dFrom === bridge.to && dTo === bridge.from)) return { ok: false, reason: `bridge ${bridgeId} joins ${bridge.from} and ${bridge.to} intensities only` };
  const t = parseDec(bridge.tonnesPerUnit) as Dec;
  const gas = to.gas ? { gas: to.gas } : {};
  const step = convertValue(value, from, { n: to.n, d: canonId(dFrom), ...gas }, sig + 3);
  if (!step.ok) return step;
  return convertValue(forward ? mulDec(step.value, t) : divDec(step.value, t, 40), { n: to.n, d: canonId(dTo), ...gas }, to, sig);
}
