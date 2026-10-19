// Number literals and their locale (U1). The locale is a property of the DOCUMENT: declared by the capture, else detected from every unambiguous
// number in the text (a majority must agree), else the stated default; a document that mixes conventions without a resolvable majority is
// REFUSED, never guessed token by token. A single-separator literal ("9,000", "3,114", "1,95") is read by that locale and by nothing else.
import { LOCALE_FILE, LOCALES, SEP_CLASS, SPACE_CLASS } from "./data";

/** `literal` is the whole run including space groups; `base` is the run without them, the fallback when the grouped reading is not a valid number. */
export interface NumberToken { start: number; end: number; literal: string; base: string }
export type Interpreted = { ok: true; text: string; decimals: number } | { ok: false; reason: string };
export type LocaleVerdict = { locale: string; basis: "declared" | "detected" | "default" } | { locale: null; reason: string };

const BASE = new RegExp(`\\d+(?:[${SEP_CLASS}]\\d+)*`, "g");
const SEP_ONLY = new RegExp(`[${SEP_CLASS}]`, "g");
const GROUP_AFTER = new RegExp(`^[${SPACE_CLASS}]\\d{3}(?!\\d)`);
const FRACTION_GROUP = new RegExp(`^[${SPACE_CLASS}]\\d{1,3}(?!\\d)`);
const DECIMAL_TAIL = new RegExp(`^[${SEP_CLASS}]\\d+`);
const SEPARATOR = new RegExp(`[${SEP_CLASS}${SPACE_CLASS}]`);
const isSpace = (c: string): boolean => LOCALE_FILE.groupSpaces.includes(c);

/** Every number literal in `text`, a digit run taken WHOLE: "50" inside "€50" or "2019/883" is never a number of its own. Space groups ("15 000", "0.907 184 74") are absorbed. */
export function scanNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(BASE)) {
    if (m.index < (out[out.length - 1]?.end ?? 0)) continue;
    const start = m.index;
    const baseEnd = start + m[0].length;
    let end = baseEnd;
    const seps = m[0].match(SEP_ONLY) ?? [];
    if (seps.length === 0 && m[0].length <= 3) {
      for (let g = GROUP_AFTER.exec(text.slice(end)); g; g = GROUP_AFTER.exec(text.slice(end))) end += g[0].length;
      const tail = DECIMAL_TAIL.exec(text.slice(end));
      if (tail && end > baseEnd) end += tail[0].length;
    } else if (seps.length === 1 && /^\d+\D\d{3}$/.test(m[0])) {
      for (let g = FRACTION_GROUP.exec(text.slice(end)); g; g = FRACTION_GROUP.exec(text.slice(end))) {
        end += g[0].length;
        if (g[0].length < 4) break;
      }
    }
    out.push({ start, end, literal: text.slice(start, end), base: m[0] });
  }
  return out;
}

/** Read one literal under one locale: exact value and decimals, or the reason it is not a valid number there. */
export function interpretNumber(literal: string, localeId: string): Interpreted {
  const loc = LOCALES[localeId];
  if (!loc) return { ok: false, reason: `unknown locale ${localeId}` };
  const groups = literal.split(SEPARATOR);
  const seps = literal.split("").filter((c) => SEPARATOR.test(c));
  if (!seps.length) return { ok: true, text: literal, decimals: 0 };
  const isGroup = (c: string): boolean => isSpace(c) || loc.thousands.includes(c);
  const last = seps.length - 1;
  let at = -1;
  if (seps[last] === loc.decimal) at = last;
  else if (LOCALE_FILE.fractionGroupLocales.includes(localeId)) {
    const i = seps.indexOf(loc.decimal);
    if (i >= 0 && seps.slice(i + 1).every(isSpace)) at = i;
  }
  const intSeps = at < 0 ? seps : seps.slice(0, at);
  const intGroups = at < 0 ? groups : groups.slice(0, at + 1);
  if (!intSeps.every(isGroup)) return { ok: false, reason: `separator ${seps.find((c) => !isGroup(c) && c !== loc.decimal) ?? seps[last]} is not a digit-group separator in locale ${localeId}` };
  if (intSeps.length && ((intGroups[0] ?? "").length > 3 || (intGroups[0] ?? "").startsWith("0"))) return { ok: false, reason: `leading group "${intGroups[0]}" cannot start a grouped number in locale ${localeId}` };
  if (intGroups.slice(1).some((g) => g.length !== 3)) return { ok: false, reason: `digit groups of ${literal} are not groups of three in locale ${localeId}` };
  const frac = at < 0 ? "" : groups.slice(at + 1).join("");
  return { ok: true, text: `${intGroups.join("")}${at < 0 ? "" : `.${frac}`}`, decimals: frac.length };
}

/** The locales that read `literal` validly: a literal valid under only some locales is evidence for those. */
const readers = (literal: string): string[] => Object.keys(LOCALES).filter((l) => interpretNumber(literal, l).ok);

/** The locale of one document: declared wins; else the majority of the unambiguous literals; no evidence uses the stated default; a split with no majority is refused. */
export function resolveLocale(text: string, declared?: string | null): LocaleVerdict {
  if (declared) return LOCALES[declared] ? { locale: declared, basis: "declared" } : { locale: null, reason: `declared locale ${declared} is not a known locale` };
  const all = Object.keys(LOCALES);
  const tally = new Map<string, number>();
  let voting = 0;
  for (const t of scanNumbers(text)) {
    if (!SEPARATOR.test(t.literal)) continue;
    const r = readers(t.literal);
    if (r.length === 0 || r.length === all.length) continue;
    voting += 1;
    for (const l of r) tally.set(l, (tally.get(l) ?? 0) + 1);
  }
  if (voting === 0) return { locale: LOCALE_FILE.documentDefault, basis: "default" };
  const best = [...tally].sort((a, b) => b[1] - a[1] || all.indexOf(a[0]) - all.indexOf(b[0]))[0] as [string, number];
  if (best[1] / voting < LOCALE_FILE.majorityShare) return { locale: null, reason: `document mixes number conventions with no resolvable majority (${[...tally].map(([l, n]) => `${l}:${n}`).join(", ")} of ${voting})` };
  return { locale: best[0], basis: "detected" };
}

/** Print a decimal string in a locale: digit groups of three with that locale's group separator, its decimal mark. */
export function formatNumber(value: string, localeId: string): string {
  const [int = "", frac = ""] = value.split(".");
  const group = LOCALE_FILE.displayGroupSeparator[localeId] ?? "";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return frac ? `${grouped}${LOCALES[localeId]?.decimal ?? "."}${frac}` : grouped;
}
