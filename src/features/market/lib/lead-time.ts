// Ported from old_repo/src/lib/market/lead-time-position.mjs (lines 1-96)
// The lead-time position (INV-257): the SBTi cohort in months. It renders only from at least five rows whose unit is exactly "months" (another unit is excluded, never converted); fewer is "not forecastable" with the observed
// count and the floor.
import { prefixOf, producerFor } from "./registry";

export const DEFAULT_MIN_SAMPLE = 5;

/** The section can hold a row only while rows exist or the producer that writes them does (register surfaces:15: the SBTi producer is registered as not implemented, so the position could only ever say "not forecastable"). */
export const leadTimeCanHaveRows = (rows: readonly unknown[]): boolean => rows.length > 0 || producerFor("sbti")?.implemented === true;

export interface LeadTimeRow {
  series_key?: string | null;
  label?: string | null;
  value_numeric?: number | string | null;
  unit?: string | null;
  origin_class?: string | null;
  source_key?: string | null;
  n_observations?: number | null;
  as_at_date?: string | null;
  reference_period?: string | null;
}
export interface LeadTimeEntry {
  seriesKey: string;
  label: string;
  months: number;
  originClass: string | null;
  sourceKey: string | null;
  nObservations: number | null;
  asAtDate: string | null;
  referencePeriod: string | null;
}
export interface LeadTimePosition {
  forecastable: boolean;
  sampleSize: number;
  minSample: number;
  reason: string | null;
  cohortMedianMonths: number | null;
  rows: LeadTimeEntry[];
}

export function buildLeadTimePosition(rows: readonly LeadTimeRow[], { minSample = DEFAULT_MIN_SAMPLE } = {}): LeadTimePosition {
  const usable: LeadTimeEntry[] = [];
  for (const r of rows ?? []) {
    if (!r || prefixOf(r.series_key) !== "sbti" || r.unit !== "months") continue;
    const months = typeof r.value_numeric === "number" ? r.value_numeric : Number(r.value_numeric);
    if (!Number.isFinite(months)) continue;
    usable.push({ seriesKey: r.series_key as string, label: r.label ?? (r.series_key as string), months, originClass: r.origin_class ?? null, sourceKey: r.source_key ?? null, nObservations: typeof r.n_observations === "number" ? r.n_observations : null, asAtDate: r.as_at_date ?? null, referencePeriod: r.reference_period ?? null });
  }
  if (usable.length < minSample) {
    return { forecastable: false, sampleSize: usable.length, minSample, reason: usable.length === 0 ? "no lead-time rows are on record" : `only ${usable.length} usable row${usable.length === 1 ? "" : "s"} on record`, cohortMedianMonths: null, rows: [] };
  }
  const sorted = [...usable].sort((a, b) => a.months - b.months);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[mid] as LeadTimeEntry).months : ((sorted[mid - 1] as LeadTimeEntry).months + (sorted[mid] as LeadTimeEntry).months) / 2;
  return { forecastable: true, sampleSize: sorted.length, minSample, reason: null, cohortMedianMonths: median, rows: sorted };
}
