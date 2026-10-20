// Ported from old_repo/src/lib/figures/format-range.mjs (lines 1-25)
// Ported from old_repo/src/lib/market/series-board-view-model.mjs (lines 6-46)
// Ported from old_repo/src/lib/market/refresh-published-price-statistics.mjs (lines 30-51)
// The ONE figure formatter. A currency draws as its symbol (an unknown code is shown as the code, never a guessed symbol); the unit loses a redundant "<CCY>/" prefix.

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({ EUR: "€", USD: "$", GBP: "£" });

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

