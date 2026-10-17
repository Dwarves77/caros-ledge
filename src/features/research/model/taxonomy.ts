// Ported from old_repo/src/lib/research/taxonomy.mjs (lines 1-177)
// The research taxonomy: the seven themes (the database's own theme values, labels and the four drawn descriptions), the theme of an item (the stored column first, else the ONE keyword rule set in ../theme-rules,
// which counts distinct matches so a specific pattern is never shadowed by a general one), and the four-band severity with the 13-value column map. `now` is always passed in: nothing here reads a clock.
import { classifyTheme, THEME_VALUES, UNCLASSIFIED } from "../theme-rules";

export const THEME_LABELS: Readonly<Record<string, string>> = {
  emissions_accounting: "Emissions accounting",
  fuels_saf: "Fuels & SAF",
  packaging_circular: "Packaging & circular",
  carbon_markets: "Carbon markets",
  cold_chain_art: "Cold-chain & art",
  last_mile_electrification: "Last-mile electrification",
  disclosure_regimes: "Disclosure regimes",
};
/** The artboard's own one-line descriptions; a theme it does not draw carries none rather than an invented one. */
export const THEME_DESCRIPTIONS: Readonly<Record<string, string>> = {
  emissions_accounting: "Methodology shifts that change how the workspace reports Scope 3.",
  fuels_saf: "Production capacity, feedstock constraints, price trajectory.",
  last_mile_electrification: "EV cargo capacity, charging rollout, zero-emission cargo bays.",
  disclosure_regimes: "CSRD omnibus, ISSB S2, emerging frameworks.",
};
export const UNCLASSIFIED_LABEL = "Unclassified";
/** The theme facet's order: the database's own order. */
export const THEME_KEYS: readonly string[] = THEME_VALUES;
export const themeLabel = (key: string): string => (key === UNCLASSIFIED ? UNCLASSIFIED_LABEL : (THEME_LABELS[key] ?? key));
/** "+N new" on a theme pill counts items added inside this window. */
export const NEW_WINDOW_DAYS = 7;

/** An item's theme: the stored column when it is a known theme, else the keyword rules over its own words; null (never a guessed default) when neither says. */
export function themeOf(r: { theme?: string | undefined; title?: string | undefined; whatIsIt?: string | undefined; whyMatters?: string | undefined }): string | null {
  if (r.theme && THEME_KEYS.includes(r.theme)) return r.theme;
  const verdict = classifyTheme([r.title, r.whatIsIt, r.whyMatters].filter(Boolean).join(" "));
  return verdict.theme === UNCLASSIFIED ? null : verdict.theme;
}

export type Severity = "action" | "cost" | "monitor" | "background";
export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = { action: "Action required", cost: "Cost alert", monitor: "Monitor", background: "Background" };
/** The 13 values migration 102's CHECK admits, each to exactly one of the four display bands (the market vocabulary, the priority vocabulary, the catch-all vocabulary). */
export const SEVERITY_COLUMN_TO_KEY: Readonly<Record<string, Severity>> = {
  action_required: "action", cost_alert: "cost", window_closing: "action", competitive_edge: "monitor", monitoring: "monitor",
  critical: "action", high: "cost", moderate: "monitor", low: "background",
  immediate: "action", watch: "monitor", reference: "background", background: "background",
};
const FORTNIGHT_MS = 14 * 86_400_000;

/** The stored column wins; with none stored, an action phrase, then a cost phrase, then recency (under 14 days from `now`), else background. */
export function severityOf(text: string, addedDate: string | null | undefined, column: string | null | undefined, now: Date): Severity {
  const stored = typeof column === "string" ? SEVERITY_COLUMN_TO_KEY[column.toLowerCase()] : undefined;
  if (stored) return stored;
  const t = (text || "").toLowerCase();
  if (/\b(action required|immediate|deadline|must file|cease)\b/.test(t)) return "action";
  if (/\b(cost|surcharge|pass[- ]?through|price|margin|\/kwh|tco)\b/.test(t)) return "cost";
  const age = addedDate ? now.getTime() - new Date(addedDate).getTime() : NaN;
  return age >= 0 && age < FORTNIGHT_MS ? "monitor" : "background";
}
