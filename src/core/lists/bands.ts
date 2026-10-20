// Ported from old_repo/src/lib/urgency/bands.ts (lines 1-131)
// The one urgency vocabulary: four bands, hot to cool. Platform priority maps to a band here and nowhere else (INV-215).
export type UrgencyBandKey = "immediate" | "action" | "monitor" | "awareness";
export type PlatformPriority = "CRITICAL" | "HIGH" | "MODERATE" | "LOW";

export interface UrgencyBand {
  key: UrgencyBandKey;
  label: string;
  window: string;
  /** Band hue as a literal: the declared exception for the alpha-suffixed ring and the gradient stops (src/ui/theme.css holds the same values). */
  hex: string;
  cssVar: string;
  tintCssVar: string;
  borderCssVar: string;
  priority: PlatformPriority;
}

const band = (key: UrgencyBandKey, label: string, window: string, hex: string, priority: PlatformPriority): UrgencyBand => ({
  key,
  label,
  window,
  hex,
  cssVar: `var(--${key})`,
  tintCssVar: `var(--${key}-tint)`,
  borderCssVar: `var(--${key}-border)`,
  priority,
});

export const BAND_ORDER: readonly UrgencyBand[] = [
  band("immediate", "Immediate", "≤ 90 days", "#DC2626", "CRITICAL"),
  band("action", "Action", "≤ 6 months", "#F97316", "HIGH"),
  band("monitor", "Monitor", "6–12 months", "#2563EB", "MODERATE"),
  band("awareness", "Awareness", "later", "#16A34A", "LOW"),
];

const BY_PRIORITY = new Map<string, UrgencyBand>(BAND_ORDER.map((b) => [b.priority, b]));
const AWARENESS = BAND_ORDER[3] as UrgencyBand;

export const bandOf = (key: UrgencyBandKey): UrgencyBand => BAND_ORDER.find((b) => b.key === key) ?? AWARENESS;

/**
 * The spine of a row that carries no urgency of its own (an entity, a source, a series, a priority the row does not hold): neutral grey, in no band group and in no band count. The kit's row type asks
 * for a band, so `key` and `priority` are the lowest band's; nothing groups by them and every colour is neutral (S:84, F:54).
 */
export const NEUTRAL_BAND: UrgencyBand = Object.freeze({ ...AWARENESS, label: "No priority", window: "", hex: "#7A6E6C", cssVar: "var(--ink-3)", tintCssVar: "var(--tag)", borderCssVar: "var(--line-2)" });

/** The band of a stored priority. A missing or unknown priority is the neutral band, never Awareness: a priority nobody set is not the lowest urgency. */
export function bandFromPriority(priority: PlatformPriority | string | null | undefined): UrgencyBand {
  return (priority ? BY_PRIORITY.get(priority) : undefined) ?? NEUTRAL_BAND;
}

/** The stored priority, or a thrown refusal: the column is a closed set the database enforces, so a row without one is a malformed read, never a row at some default priority (S:84, closed enums refuse at load). */
export function requirePriority(value: unknown, what: string): PlatformPriority {
  if (typeof value === "string" && BY_PRIORITY.has(value)) return value as PlatformPriority;
  throw new Error(`${what} carries no valid priority (${JSON.stringify(value)})`);
}

/** Days to the next binding date to a band (the same windows the priority pipeline uses). */
export function classifyByDays(days: number | null | undefined): UrgencyBand {
  if (days == null || Number.isNaN(days)) return AWARENESS;
  if (days <= 90) return BAND_ORDER[0] as UrgencyBand;
  if (days <= 182) return BAND_ORDER[1] as UrgencyBand;
  return days <= 365 ? (BAND_ORDER[2] as UrgencyBand) : AWARENESS;
}
