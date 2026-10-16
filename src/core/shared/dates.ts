// Ported from old_repo/src/lib/format.ts (lines 1-85)
// Ported from old_repo/src/lib/relative-time.ts (lines 1-78)
// Ported from old_repo/src/components/auth/AuthFrame.tsx (lines 35-41)
// Ported from old_repo/src/lib/workspace/item-assignments.mjs (lines 15-23)
export const FIXED_LOCALE = "en-US";
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

export function toDate(input: string | Date | null | undefined): Date | null {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

const UNITS: [string, number][] = [["y", 365 * 86_400_000], ["mo", 30 * 86_400_000], ["w", 7 * 86_400_000], ["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]];

/** "5m ago", "3d ago", "just now"; empty for an unparseable input. */
export function formatRelativeCompact(input: string | Date | null | undefined, now: Date | number = Date.now()): string {
  const d = toDate(input);
  if (!d) return "";
  const diff = (typeof now === "number" ? now : now.getTime()) - d.getTime();
  const unit = UNITS.find(([, ms]) => diff >= ms);
  return unit ? `${Math.floor(diff / unit[1])}${unit[0]} ago` : "just now";
}

/** "5 min ago", "in 3 days": long form, past and future. */
export function formatRelative(ts: Date, now: Date | number = Date.now()): string {
  const diff = (typeof now === "number" ? now : now.getTime()) - ts.getTime();
  const abs = Math.abs(diff);
  const long: [string, number, boolean][] = [["year", 365 * 86_400_000, true], ["month", 30 * 86_400_000, true], ["week", 7 * 86_400_000, true], ["day", 86_400_000, true], ["hr", 3_600_000, false], ["min", 60_000, false]];
  const unit = long.find(([, ms]) => abs >= ms);
  if (!unit) return diff < 0 ? "in 1 min" : "just now";
  const n = Math.round(abs / unit[1]);
  const label = unit[2] ? `${unit[0]}${n === 1 ? "" : "s"}` : unit[0];
  return diff < 0 ? `in ${n} ${label}` : `${n} ${label} ago`;
}

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
