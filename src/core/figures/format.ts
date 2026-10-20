// Ported from old_repo/src/lib/figures/format-range.mjs (lines 1-25)
// Ported from old_repo/src/lib/figures/uncertainty.mjs (lines 1-1)
// Ported from old_repo/src/lib/market/series-board-view-model.mjs (lines 6-46)
// Ported from old_repo/src/lib/market/refresh-published-price-statistics.mjs (lines 30-51)
// The ONE figure formatter. A currency draws as its symbol (an unknown code is shown as the code, never a guessed symbol); the unit loses a redundant "<CCY>/" prefix; a missing bound of a range is NAMED.
import { formatNumber } from "@/core/shared";

/** The sensitivity convention for a non-contractable input: plus or minus this share of its value. */
const UNCERTAINTY_PCT = 0.1;
const CURRENCY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({ EUR: "€", USD: "$", GBP: "£" });

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** Whole numbers from 1,000 up, two decimals below. */
const plain = (n: number): string => formatNumber(n, { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
const prefixed = (n: number, currency: string | null | undefined): string => {
  const symbol = currency ? CURRENCY_SYMBOL[currency] : undefined;
  return symbol ? `${symbol}${plain(n)}` : currency ? `${currency} ${plain(n)}` : plain(n);
};

/** The unit as a suffix: "EUR/1000L" under currency EUR is "/1000L" (the currency is already drawn), any other unit follows a space. */
function unitSuffix(unit: string | null | undefined, currency: string | null | undefined): string {
  if (!unit) return "";
  return currency && unit.startsWith(`${currency}/`) ? unit.slice(currency.length) : ` ${unit}`;
}

/** A value with its currency and unit: "€1,493.60/1000L". A value that is absent or not a number has an emptyReason and the dash text; it is never 0. */
export function formatFigure(value: unknown, unit?: string | null, currency?: string | null): { text: string; emptyReason: string | null } {
  if (value === null || value === undefined) return { text: "—", emptyReason: "no value observed" };
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return { text: "—", emptyReason: "value is not a number" };
  const symbol = currency ? CURRENCY_SYMBOL[currency] : undefined;
  const body = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const head = symbol ? `${symbol}${body}` : currency ? `${body} ${currency}` : body;
  return { text: `${head}${unitSuffix(unit, currency)}`, emptyReason: null };
}

/** low – point – high. Bounds that are missing are named, never printed as a dash; a range whose bounds are out of order says so instead of being re-sorted. */
export function formatRange(low: number | null | undefined, point: number | null | undefined, high: number | null | undefined, unit: string | null | undefined, currency: string | null | undefined): string {
  const suffix = currency ? "" : unit ? ` ${unit}` : "";
  const one = (n: number) => `${prefixed(n, currency)}${suffix}`;
  const present = [low, point, high].filter(finite);
  const missing = (["low", "point", "high"] as const).filter((k, i) => !finite([low, point, high][i]));
  if (present.length === 0) return "no figure stated";
  const body = present.map(one).join(" – ");
  if (missing.length) return `${body} (${missing.join(" and ")} not stated)`;
  return present.every((n, i) => i === 0 || (present[i - 1] as number) <= n) ? body : `${body} (bounds out of order)`;
}

/** The scenario band of one non-contractable input. */
export const sensitivityBand = (value: number, pct: number = UNCERTAINTY_PCT): { low: number; high: number } => ({ low: value * (1 - pct), high: value * (1 + pct) });
