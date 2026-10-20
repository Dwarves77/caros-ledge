// Ported from old_repo/src/lib/market/series-board-view-model.mjs (lines 1-199)
// Ported from old_repo/src/lib/market/refresh-published-price-statistics.mjs (lines 54-73)
// The series board (INV-253): the latest observation of every series, grouped by registry producer, with the deltas computed from EVERY row seen for the series. A key whose prefix no producer claims is shown in an
// unregistered bucket, never dropped. Display values come from the one figure formatter, so the board and the published price board cannot disagree.
import { formatFigure } from "@/core/figures";

import { latestPerSeries } from "../producers/published-price-statistics";

import { computeSeriesDeltas, type SeriesDeltas, type SeriesObservation } from "./deltas";
import { prefixOf, PRODUCERS, type Producer } from "./registry";

export interface SeriesRow extends SeriesObservation {
  series_key: string;
  id?: string | null;
  derivation?: string | null;
  origin_class?: string | null;
  source_key?: string | null;
  source_ref?: string | null;
  method_version?: string | null;
  n_observations?: number | null;
  /** How many observations the series has on record, counted before the reader windowed its history (the rows given may be only the recent ones). */
  observations_on_record?: number;
}
export interface SeriesDisplayRow {
  seriesKey: string;
  /** The winning row's own market_series id: the identity a watch on this observation uses. */
  id: string | null;
  label: string;
  displayValue: string;
  emptyReason: string | null;
  asAtDate: string | null;
  referencePeriod: string | null;
  observationCount: number;
  sourceKey: string | null;
  sourceRef: string | null;
  unit: string | null;
  currency: string | null;
  derivation: string | null;
  originClass: string | null;
  methodVersion: string | null;
  nObservations: number | null;
  deltas: SeriesDeltas;
}
export type GroupState = "not_built" | "registered_unpopulated" | "populated";
export interface ProducerGroup extends Producer {
  state: GroupState;
  series: SeriesDisplayRow[];
}
export interface SeriesBoard {
  groups: ProducerGroup[];
  unregistered: SeriesDisplayRow[];
  totalObservedSeries: number;
  totalProducers: number;
  implementedProducerCount: number;
  isEmpty: boolean;
}

export function buildSeriesBoard(rows: readonly SeriesRow[], opts: { producers?: readonly Producer[] } = {}): SeriesBoard {
  const producers = opts.producers ?? PRODUCERS;
  const bySeries = new Map<string, SeriesRow[]>();
  for (const r of rows) if (r?.series_key) bySeries.set(r.series_key, [...(bySeries.get(r.series_key) ?? []), r]);
  const latest = latestPerSeries(rows.filter((r) => r?.series_key) as never) as Map<string, SeriesRow>;

  const display = (seriesKey: string, row: SeriesRow): SeriesDisplayRow => {
    const { text, emptyReason } = formatFigure(row.value_numeric, row.unit, row.currency);
    const all = bySeries.get(seriesKey) ?? [row];
    return {
      seriesKey,
      id: row.id ?? null,
      label: row.label ?? seriesKey,
      displayValue: text,
      emptyReason,
      asAtDate: row.as_at_date ?? null,
      referencePeriod: row.reference_period ?? null,
      observationCount: row.observations_on_record ?? all.length,
      sourceKey: row.source_key ?? null,
      sourceRef: row.source_ref ?? null,
      unit: row.unit ?? null,
      currency: row.currency ?? null,
      derivation: row.derivation ?? null,
      originClass: row.origin_class ?? null,
      methodVersion: row.method_version ?? null,
      nObservations: typeof row.n_observations === "number" ? row.n_observations : null,
      deltas: computeSeriesDeltas(all),
    };
  };
  const byKey = (a: SeriesDisplayRow, b: SeriesDisplayRow) => a.seriesKey.localeCompare(b.seriesKey);

  const claimed = new Set<string>();
  const groups = producers.map((p): ProducerGroup => {
    const series = [...latest].filter(([k]) => prefixOf(k) === p.keyPrefix).map(([k, row]) => (claimed.add(k), display(k, row))).sort(byKey);
    return { ...p, state: !p.implemented ? "not_built" : series.length === 0 ? "registered_unpopulated" : "populated", series };
  });
  const unregistered = [...latest].filter(([k]) => !claimed.has(k)).map(([k, row]) => display(k, row)).sort(byKey);
  const total = groups.reduce((n, g) => n + g.series.length, 0) + unregistered.length;
  return { groups, unregistered, totalObservedSeries: total, totalProducers: producers.length, implementedProducerCount: producers.filter((p) => p.implemented).length, isEmpty: total === 0 };
}
