// Ported from old_repo/src/lib/format.ts (lines 1-85)
// Ported from old_repo/src/lib/relative-time.ts (lines 1-78)
// Ported from old_repo/src/components/auth/AuthFrame.tsx (lines 35-41)
// Ported from old_repo/src/lib/workspace/item-assignments.mjs (lines 15-23)
const FIXED_LOCALE = "en-US";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 4, 2026" from an ISO date or datetime; "Mar 2026" when there is no day; the input back when unparseable. */
export function formatDate(iso: string | undefined | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split(/[-T]/);
  const year = parseInt(y ?? "", 10);
  const month = MONTHS[parseInt(m ?? "", 10) - 1];
  if (Number.isNaN(year) || !month) return iso;
  const day = d ? parseInt(d, 10) : NaN;
  return day ? `${month} ${day}, ${year}` : `${month} ${year}`;
}

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string => value.toLocaleString(FIXED_LOCALE, options);
/** A computed figure as a person reads it: separators and at most six decimals, so a float's noise (13.209999999999999) never reaches a page. */
export const formatFigure = (value: number): string => formatNumber(value, { maximumFractionDigits: 6 });
export const formatLocaleDate = (date: Date, options?: Intl.DateTimeFormatOptions): string => date.toLocaleDateString(FIXED_LOCALE, options);
export const formatLocaleDateTime = (date: Date, options?: Intl.DateTimeFormatOptions): string => date.toLocaleString(FIXED_LOCALE, options);
export const pluralize = (count: number, singular: string, plural?: string): string => (Math.abs(count) === 1 ? singular : (plural ?? `${singular}s`));
export const countNoun = (count: number, singular: string, plural?: string): string => `${formatNumber(count)} ${pluralize(count, singular, plural)}`;

/** The ISO 8601 week number of a date (its local calendar day). */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
