// Ported from old_repo/src/components/list-surface/list-surface-helpers.ts (lines 6-127)
// Ported from old_repo/src/components/list-surface/list-surface-helpers.ts (lines 347-411)
// Facet options and the live counts (INV-267): corpus figures only at rest; with a selection, tallies over the rows with the group's OWN selection removed.
import { orderedValues } from "@/core/contracts";
import { BAND_ORDER, bandFromPriority, type UrgencyBandKey } from "@/core/lists";
import type { Resource } from "@/core/types";

import { filterRows, isFilterActive, type RowFilterState } from "./filter-sort";

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  countLabel?: string;
}
export type BandFacetOption = FacetOption & { key: UrgencyBandKey };

const MODE_LABEL: Record<string, string> = Object.fromEntries(orderedValues("transport_mode").map((m) => [m.code, m.label ?? m.code]));
const byCountThenLabel = (a: FacetOption, b: FacetOption): number => b.count - a.count || a.label.localeCompare(b.label);
function tally(keys: Iterable<string>, label: (k: string) => string = (k) => k): FacetOption[] {
  const counts = new Map<string, number>();
  for (const k of keys) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, label: label(value), count })).sort(byCountThenLabel);
}

export const facetOptions = {
  mode: (rows: Resource[]): FacetOption[] => tally(rows.flatMap((r) => (r.modes ?? []).map((m) => m.trim())), (c) => MODE_LABEL[c] ?? c),
  topic: (rows: Resource[]): FacetOption[] => tally(rows.map((r) => (r.topic ?? "").trim())),
  tier: (rows: Resource[]): FacetOption[] =>
    tally(rows.filter((r) => r.sourceTier != null).map((r) => String(r.sourceTier)), (t) => `T${t}`).sort((a, b) => Number(a.value) - Number(b.value)),
  /** From the corpus tallies when given, else from the rows (jurisdiction name, "global" when unset). */
  region: (rows: Resource[], byJurisdiction?: Record<string, number>): FacetOption[] =>
    byJurisdiction && Object.keys(byJurisdiction).length > 0 ? Object.entries(byJurisdiction).map(([value, count]) => ({ value, label: value, count })).sort(byCountThenLabel) : tally(rows.map((r) => (r.jurisdiction || "global").trim())),
  band: (rows: Resource[], byPriority?: Record<string, number>): BandFacetOption[] => {
    const counts = new Map<UrgencyBandKey, number>();
    if (!byPriority) for (const r of rows) counts.set(bandFromPriority(r.priority).key, (counts.get(bandFromPriority(r.priority).key) ?? 0) + 1);
    return BAND_ORDER.map((b) => ({ key: b.key, value: b.key, label: b.label, count: byPriority ? (byPriority[b.priority] ?? 0) : (counts.get(b.key) ?? 0) }));
  },
};

export interface FacetCorpusCounts {
  byPriority?: Record<string, number>;
  byJurisdiction?: Record<string, number>;
  totalItems?: number;
}
export interface LiveFacetCounts {
  band: BandFacetOption[];
  mode: FacetOption[];
  region: FacetOption[];
  topic: FacetOption[];
  tier: FacetOption[];
  total: number;
  /** True when the counts are tallies over the current selection rather than corpus figures. */
  liveSelection: boolean;
}

const without = (f: RowFilterState, facet: keyof RowFilterState): RowFilterState => ({ ...f, [facet]: facet === "query" ? "" : null });

/** Each group counts over the rows filtered by every OTHER group, so choosing a value never zeroes its own siblings. */
export function liveFacetCounts(rows: Resource[], filter: RowFilterState, corpus: FacetCorpusCounts = {}): LiveFacetCounts {
  const live = isFilterActive(filter);
  const rowsFor = (facet: keyof RowFilterState) => (live ? filterRows(rows, without(filter, facet)) : rows);
  return {
    band: facetOptions.band(rowsFor("band"), live ? undefined : corpus.byPriority),
    mode: facetOptions.mode(rowsFor("mode")),
    region: facetOptions.region(rowsFor("region"), live ? undefined : corpus.byJurisdiction),
    topic: facetOptions.topic(rowsFor("topic")),
    tier: facetOptions.tier(rowsFor("tier")),
    total: live ? filterRows(rows, filter).length : corpus.totalItems || rows.length,
    liveSelection: live,
  };
}
