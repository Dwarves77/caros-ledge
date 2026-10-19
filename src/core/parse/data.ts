// The parse module's rule tables, loaded once and validated with zod: units, locales, identifier schemes, missing-value tokens and figure qualifiers
// live in ./data/*.json. A malformed table throws at import, so a bad edit fails the first test, never a customer figure. No unit, locale glyph or
// identifier scheme is a literal anywhere in the module's functions (tests/parse/structure.test.ts refuses one).
import { z } from "zod";

import identifierFile from "./data/identifier-schemes.json";
import localeFile from "./data/locales.json";
import missingFile from "./data/missing-tokens.json";
import qualifierFile from "./data/qualifiers.json";
import unitFile from "./data/units.json";

const dec = z.string().regex(/^\d+(?:\.\d+)?$/);
const unit = z.object({ id: z.string().min(1), dim: z.string().min(1), factor: dec, label: z.string(), symbols: z.array(z.string().min(1)), words: z.array(z.string().min(1)), money: z.boolean().optional(), display: z.enum(["prefix", "suffix", "tight"]).optional(), trajectory: z.boolean().optional() });
const units = z.object({
  units: z.array(unit).min(1),
  gases: z.array(z.object({ id: z.string().min(1), aliases: z.array(z.string().min(1)).min(1) })).min(1),
  scales: z.array(z.object({ word: z.string().min(1), exp: z.number().int().positive() })),
  intensity: z.object({ numeratorDims: z.array(z.string()).min(1), denominatorDims: z.array(z.string()).min(1), perWords: z.array(z.string()).min(1), functionalUnitStop: z.array(z.string()) }),
  activities: z.array(z.object({ dims: z.array(z.string()).min(1), activity: z.string() })),
  bridges: z.array(z.object({ id: z.string().min(1), from: z.string(), to: z.string(), tonnesPerUnit: dec, source: z.string().min(1) })),
});
const locales = z.object({
  locales: z.record(z.string(), z.object({ decimal: z.string().length(1), thousands: z.array(z.string().length(1)), family: z.string() })),
  groupSpaces: z.array(z.string().length(1)).min(1),
  fractionGroupLocales: z.array(z.string()),
  minusSigns: z.array(z.string().length(1)).min(1),
  majorityShare: z.number().gt(0.5).lte(1),
  documentDefault: z.string(),
  displayGroupSeparator: z.record(z.string(), z.string()),
});
const regexSource = z.string().refine((s) => { try { return !!new RegExp(s); } catch { return false; } }, "not a valid regular expression");
const scheme = z.object({ id: z.string(), kind: z.string(), context: z.boolean(), pattern: regexSource, key: z.string(), intGroups: z.array(z.string()) });
const identifiers = z.object({
  typeLetters: z.record(z.string(), z.string()),
  yearBounds: z.tuple([z.number().int(), z.number().int()]),
  schemes: z.array(scheme).min(1),
  yearRange: z.object({ pattern: regexSource }),
  cn: z.object({ digits: z.number().int(), groups: z.array(z.number().int()), printSeparator: z.string() }),
  publicSuffixes: z.array(z.string()),
  trackingParams: z.array(z.string()),
});
const missing = z.object({ tokens: z.array(z.object({ literal: z.string().min(1), kind: z.string().min(1), meaning: z.string().min(1) })).min(1) });
const patterns = z.record(z.string(), z.array(regexSource).min(1));
const qualifiers = z.object({ window: z.object({ max: z.number().int().positive() }), fields: z.record(z.string(), patterns), screeningGrade: z.array(z.string()), qualifiedDims: z.array(z.string()), frameworks: z.array(z.object({ id: z.string(), pattern: regexSource })), phaseIn: z.object({ pattern: regexSource, bare: regexSource }) });

export type Unit = z.infer<typeof unit>;
export const UNIT_FILE = units.parse(unitFile);
export const LOCALE_FILE = locales.parse(localeFile);
export const IDENT_FILE = identifiers.parse(identifierFile);
export const MISSING_FILE = missing.parse(missingFile);
export const QUALIFIER_FILE = qualifiers.parse(qualifierFile);

export const UNITS = UNIT_FILE.units;
export const UNIT_BY_ID = new Map(UNITS.map((u) => [u.id, u]));
if (UNIT_BY_ID.size !== UNITS.length) throw new Error("parse/data/units.json: duplicate unit id");
for (const d of UNIT_FILE.intensity.denominatorDims) if (!UNITS.some((u) => u.dim === d)) throw new Error(`parse/data/units.json: denominator dim ${d} has no unit`);
if (!LOCALE_FILE.locales[LOCALE_FILE.documentDefault]) throw new Error("parse/data/locales.json: documentDefault is not a locale");

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spaced = (s: string): string => escapeRe(s).replace(/ /g, "\\s+");
const normSpace = (s: string): string => s.replace(/\s+/g, " ");

/** Matched alias text to unit: a symbol is exact-case (g is grams, G is not), a word and a currency code are case-insensitive. */
const EXACT = new Map<string, Unit>();
const FOLDED = new Map<string, Unit>();
for (const u of UNITS) {
  for (const s of u.symbols) (u.money ? FOLDED : EXACT).set(u.money ? s.toLowerCase() : s, u);
  for (const w of u.words) FOLDED.set(w.toLowerCase(), u);
}
export function unitOfAlias(text: string): Unit | null {
  const t = normSpace(text);
  return EXACT.get(t) ?? FOLDED.get(t.toLowerCase()) ?? null;
}
/** A regex alternation (longest alias first, so "tkm" is tried before "t") over the aliases of the units in `from`. */
export function aliasAlternation(from: readonly Unit[], only?: "symbols"): string {
  const all = from.flatMap((u) => [...u.symbols, ...(only ? [] : u.words)]);
  return [...new Set(all)].sort((a, b) => b.length - a.length).map(spaced).join("|");
}
export const unitsOfDim = (dims: readonly string[]): Unit[] => UNITS.filter((u) => dims.includes(u.dim));

export const GAS_BY_ALIAS = new Map(UNIT_FILE.gases.flatMap((g) => g.aliases.map((a) => [a, g.id] as const)));
export const GAS_ALTERNATION = [...GAS_BY_ALIAS.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
export const SCALE_BY_WORD = new Map(UNIT_FILE.scales.map((s) => [s.word.toLowerCase(), s] as const));
export const SCALE_ALTERNATION = [...SCALE_BY_WORD.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");

/** Locale separator classes, built from the data: the separators that can appear inside a number, and the group-space characters. */
const sepChars = new Set<string>();
for (const l of Object.values(LOCALE_FILE.locales)) for (const c of [l.decimal, ...l.thousands]) sepChars.add(c);
export const SEP_CLASS = [...sepChars].map(escapeRe).join("");
export const SPACE_CLASS = LOCALE_FILE.groupSpaces.map(escapeRe).join("");
export const LOCALES = LOCALE_FILE.locales;
export const MINUS_CLASS = LOCALE_FILE.minusSigns.map(escapeRe).join("");
