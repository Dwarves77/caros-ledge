import { HTML_SPACE_ALT } from "./space";
// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 7-145)
// The date grammar of the forward-event extractor: English and Portuguese months, ISO dates, month-year, a bare year only after a trigger. A date is
// parsed at a position and only when it is a real calendar date (2023-02-30 is not one); a bare year never has a `/` after it (a citation number such as
// 2023/1805 is not a year).
const MONTHS_EN: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const MONTHS_PT: Record<string, number> = { janeiro: 1, fevereiro: 2, "março": 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

// Separators between date parts: space, tab, &nbsp; (entity and literal) in captured HTML-derived text.
const SEP = `(?:[ \t]|${HTML_SPACE_ALT})+`;
const SEP_OPT = `(?:[ \t]|${HTML_SPACE_ALT})*`;
export const MONTH_EN_ALT = Object.keys(MONTHS_EN).map((m) => (m[0] as string).toUpperCase() + m.slice(1)).join("|");
export const MONTH_PT_ALT = "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";
const FULL_EN = `(\\d{1,2})(?:st|nd|rd|th)?${SEP_OPT}(${MONTH_EN_ALT})${SEP}(\\d{4})`;
const MONTH_YEAR_EN = `(${MONTH_EN_ALT})${SEP}(\\d{4})`;
const FULL_PT = `(\\d{1,2})[ºo°]?${SEP_OPT}de${SEP}(${MONTH_PT_ALT})${SEP}de${SEP}(\\d{4})`;
const ISO = "(\\d{4})-(\\d{2})-(\\d{2})";

export type Precision = "day" | "month" | "year";
export interface ParsedDate {
  iso: string;
  precision: Precision;
}
export interface DateMatch extends ParsedDate {
  length: number;
  matchText: string;
  skip: number;
}
type Kind = "iso" | "full-en" | "full-pt" | "month-year" | "year";

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const pad2 = (n: number): string => String(n).padStart(2, "0");

function parseDateFragment(kind: Kind, groups: readonly string[]): ParsedDate | null {
  if (kind === "full-en" || kind === "full-pt") {
    const [dayStr, monthName, yearStr] = groups as [string, string, string];
    const day = parseInt(dayStr, 10);
    const year = parseInt(yearStr, 10);
    const month = (kind === "full-en" ? MONTHS_EN : MONTHS_PT)[monthName.toLowerCase()];
    return month && isValidCalendarDate(year, month, day) ? { iso: `${year}-${pad2(month)}-${pad2(day)}`, precision: "day" } : null;
  }
  if (kind === "month-year") {
    const [monthName, yearStr] = groups as [string, string];
    const year = parseInt(yearStr, 10);
    const month = MONTHS_EN[monthName.toLowerCase()];
    return month && year >= 1000 && year <= 9999 ? { iso: `${year}-${pad2(month)}-01`, precision: "month" } : null;
  }
  if (kind === "iso") {
    const [y, m, d] = (groups as [string, string, string]).map((g) => parseInt(g, 10)) as [number, number, number];
    return isValidCalendarDate(y, m, d) ? { iso: `${y}-${pad2(m)}-${pad2(d)}`, precision: "day" } : null;
  }
  if (kind === "year") {
    const year = parseInt(groups[0] as string, 10);
    return year >= 1000 && year <= 9999 ? { iso: `${year}-01-01`, precision: "year" } : null;
  }
  return null;
}

// Tried in this order at a position (ISO first so 2025-03-31 is never read as a month-year).
const DATE_TRY_ORDER: { kind: Kind; re: RegExp }[] = [
  { kind: "iso", re: new RegExp(`^${ISO}`) },
  { kind: "full-en", re: new RegExp(`^${FULL_EN}`) },
  { kind: "full-pt", re: new RegExp(`^${FULL_PT}`, "i") },
  { kind: "month-year", re: new RegExp(`^${MONTH_YEAR_EN}`) },
];
const WEEKDAY_PREFIX = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i;

/** The date starting at `pos` (a weekday prefix is skipped, and `skip` says by how much), or null. */
export function tryParseDateAt(text: string, pos: number): DateMatch | null {
  let skip = 0;
  const weekday = text.slice(pos).match(WEEKDAY_PREFIX);
  if (weekday) skip = weekday[0].length;
  const slice = text.slice(pos + skip);
  for (const { kind, re } of DATE_TRY_ORDER) {
    const m = slice.match(re);
    if (m) {
      const parsed = parseDateFragment(kind, m.slice(1));
      if (parsed) return { ...parsed, length: m[0].length, matchText: m[0], skip };
    }
  }
  return null;
}

/** A rich date at `pos`, else a bare year (1500-2499) that is not followed by `/`. */
export function tryParseDateOrBareYearAt(text: string, pos: number): DateMatch | null {
  const rich = tryParseDateAt(text, pos);
  if (rich) return rich;
  const ym = text.slice(pos).match(/^((?:1[5-9]|2[0-4])\d{2})\b/);
  if (!ym) return null;
  if (text[pos + ym[0].length] === "/") return null;
  const parsedYear = parseDateFragment("year", [ym[1] as string]);
  return parsedYear ? { ...parsedYear, length: ym[0].length, matchText: ym[0], skip: 0 } : null;
}

