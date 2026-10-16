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
  band("awareness", "Awareness", "background", "#16A34A", "LOW"),
];

const BY_PRIORITY = new Map<string, UrgencyBand>(BAND_ORDER.map((b) => [b.priority, b]));
const AWARENESS = BAND_ORDER[3] as UrgencyBand;

export const bandOf = (key: UrgencyBandKey): UrgencyBand => BAND_ORDER.find((b) => b.key === key) ?? AWARENESS;

/** An unknown or missing priority renders Awareness: never a guessed band and never an invented fifth. */
export function bandFromPriority(priority: PlatformPriority | string | null | undefined): UrgencyBand {
  return (priority ? BY_PRIORITY.get(priority) : undefined) ?? AWARENESS;
}

/** Days to the next binding date to a band (the same windows the priority pipeline uses). */
export function classifyByDays(days: number | null | undefined): UrgencyBand {
  if (days == null || Number.isNaN(days)) return AWARENESS;
  if (days <= 90) return BAND_ORDER[0] as UrgencyBand;
  if (days <= 182) return BAND_ORDER[1] as UrgencyBand;
  return days <= 365 ? (BAND_ORDER[2] as UrgencyBand) : AWARENESS;
}
