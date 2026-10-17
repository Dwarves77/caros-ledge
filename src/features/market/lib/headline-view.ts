// Ported from old_repo/src/components/market/MarketComparativeRibbon.tsx (lines 424-463, 574-606)
// What one headline card shows, as data: the label, the value (or the state it is in), the three change windows, the trend, the as-of date, the freshness state and the rating of the source. The component draws this and decides nothing.
import { envelopeFromSeriesRow, type FigureEnvelope, type SourceRating } from "./provenance";
import { deriveSeriesFreshness, type SeriesFreshness } from "./freshness";
import type { HeadlineCard } from "./headline";
import { producerFor } from "./registry";
import { absentCell, deltaCellModel, sparklineModel, type DeltaCellModel, type SparklineModel } from "./ribbon-model";

export interface HeadlineCardView {
  key: string;
  label: string;
  fold: { count: number; noun: string };
  seriesLabel: string;
  value: { text: string } | { cell: DeltaCellModel };
  w1: DeltaCellModel;
  m1: DeltaCellModel;
  yoy: DeltaCellModel;
  spark: SparklineModel | null;
  sparkAbsent: DeltaCellModel;
  asOf: string | null;
  asOfAbsent: DeltaCellModel;
  freshness: SeriesFreshness;
  rating: SourceRating | null;
  tier: number | null;
  envelope: FigureEnvelope;
}

export function headlineCardView(card: HeadlineCard, o: { ratings: Record<string, SourceRating>; nowIso: string }): HeadlineCardView {
  const { row } = card;
  const d = row.deltas;
  const producer = card.group ? (producerFor(card.group.keyPrefix) ?? null) : null;
  const rating = row.sourceKey ? (o.ratings[row.sourceKey] ?? null) : null;
  const asOf = d.latest?.date ?? row.asAtDate ?? row.referencePeriod ?? null;
  return {
    key: card.familyKey,
    label: card.label,
    fold: card.fold,
    seriesLabel: row.label,
    value: row.emptyReason ? { cell: absentCell("1w", "no_data_yet", row.emptyReason, "value") } : { text: row.displayValue },
    w1: deltaCellModel(d, "1w"),
    m1: deltaCellModel(d, "1m"),
    yoy: deltaCellModel(d, "YoY"),
    spark: sparklineModel(d.sparkline),
    sparkAbsent: absentCell("1w", "no_data_yet", "Needs at least two numeric observations to draw a trend.", "trend"),
    asOf,
    asOfAbsent: absentCell("1w", "no_data_yet", "No observation date on record.", "as of"),
    freshness: deriveSeriesFreshness({ as_at_date: row.asAtDate, reference_period: row.referencePeriod }, producer, o.nowIso),
    rating,
    tier: rating?.tier ?? null,
    envelope: envelopeFromSeriesRow(row, producer, rating),
  };
}
