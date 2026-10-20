// Ported from old_repo/src/lib/map/jurisdiction-rollup.ts (lines 1-46)
// Ported from old_repo/src/components/map/MapPageView.tsx (lines 53-250)
// Regulation rows to jurisdiction rows, by ISO code: ONE jurisdiction model (the old map keyed by the legacy slug plus a title heuristic that put "Carbon levy in Japan" under US). A row counts once,
// under its primary code rolled up to its country (US-CA is US); a row with no code falls back to its legacy slug. The band of a jurisdiction is the most urgent band any of its rows holds.
import { countryOf, isoCodesOf, isoToDisplayLabel, legacyLabelOfIso } from "@/core/jurisdictions";
import { BAND_ORDER, bandFromPriority, type UrgencyBand } from "@/core/lists";
import { JURISDICTIONS } from "@/core/workspace/vocabulary";

import { regionGroupOf } from "./centroids";

export interface MapItem {
  id: string;
  title: string;
  priority: string;
  modes: string[];
  topic?: string | undefined;
  jurisdictionIso?: string[] | undefined;
  jurisdiction?: string | undefined;
}
export interface JurisdictionRow {
  key: string;
  label: string;
  /** The code shown on the register row: the key itself when it is short enough to be one, else nothing (never an invented abbreviation). */
  code: string;
  count: number;
  band: UrgencyBand;
  themes: string;
  /** Every code under this key, for the link into the Regulations list. */
  codes: string[];
}

/** The key a row counts under. */
export function jurisdictionKeyOf(r: Pick<MapItem, "jurisdictionIso" | "jurisdiction">): string {
  const primary = isoCodesOf(r)[0];
  if (primary) return countryOf(primary) ?? primary;
  return (r.jurisdiction || "global").toLowerCase();
}
const labelOfKey = (key: string): string => legacyLabelOfIso(key) ?? (JURISDICTIONS.find((j) => j.id === key)?.label ?? (/^[A-Z]{2}$|^(EU|GLOBAL|IMO|ICAO)$/.test(key) ? isoToDisplayLabel(key) : key.toUpperCase()));

const mostUrgent = (items: readonly MapItem[]): UrgencyBand => BAND_ORDER.find((b) => items.some((r) => bandFromPriority(r.priority).key === b.key)) ?? (BAND_ORDER[BAND_ORDER.length - 1] as UrgencyBand);

/** Jurisdiction rows, most items first (ties by label, so the order is total). */
export function rollup(items: readonly MapItem[]): JurisdictionRow[] {
  const groups = new Map<string, MapItem[]>();
  for (const r of items) groups.set(jurisdictionKeyOf(r), [...(groups.get(jurisdictionKeyOf(r)) ?? []), r]);
  return [...groups]
    .map(([key, rows]) => {
      const topics = new Map<string, number>();
      for (const r of rows) if (r.topic) topics.set(r.topic, (topics.get(r.topic) ?? 0) + 1);
      const themes = [...topics].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t.charAt(0).toUpperCase() + t.slice(1)).join(" · ");
      return { key, label: labelOfKey(key), code: key.length <= 6 ? key.toUpperCase() : "", count: rows.length, band: mostUrgent(rows), themes, codes: [...new Set(rows.flatMap((r) => isoCodesOf(r)))] };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The six region chips and the keys each holds: groups from the centroid data, the EU chip including the member states (the old chip held the slug "eu" alone, so items coded Germany never matched it). */
export type RegionChip = "EU" | "US" | "UK" | "LATAM" | "APAC" | "MEAF";
export const REGION_CHIPS: readonly RegionChip[] = ["EU", "US", "UK", "LATAM", "APAC", "MEAF"];
export function chipOfKey(key: string, euMembers: ReadonlySet<string>): RegionChip | null {
  const k = key.toUpperCase();
  if (k === "EU" || euMembers.has(k)) return "EU";
  if (k === "US") return "US";
  if (k === "GB") return "UK";
  const group = regionGroupOf(key);
  if (group === "Americas" && k !== "CA") return "LATAM";
  if (group === "Asia-Pacific" || group === "Oceania") return "APAC";
  if (group === "Middle East" || group === "Africa") return "MEAF";
  return null;
}
