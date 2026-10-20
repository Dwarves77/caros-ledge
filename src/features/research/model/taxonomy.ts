// Ported from old_repo/src/lib/research/taxonomy.mjs (lines 1-177)
// The research taxonomy: the seven themes (the database's own theme values, labels and the four drawn descriptions), the theme of an item (the stored column first, else the ONE keyword rule set in ../theme-rules,
// which counts distinct matches so a specific pattern is never shadowed by a general one). The severity of a row is its stored column in the one vocabulary (@/features/market/lib/severity); nothing here guesses it.
import { classifyTheme, THEME_VALUES, UNCLASSIFIED } from "../theme-rules";

const THEME_LABELS: Readonly<Record<string, string>> = {
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
