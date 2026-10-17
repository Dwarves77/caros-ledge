// Ported from old_repo/src/components/market/MarketSeriesBoard.tsx (lines 1-257)
// The series board (/market/series, INV-253): every producer the product carries as a card whether or not it has written a row (a producer with none says so), every observed series with its value, period, observation count, freshness,
// the rating of its source and the methodology drawer; a series no producer claims is listed, never dropped. The state words are the reader's, not the table's.
import { TierChip } from "@/ui";
import { SectionCard } from "@/ui/SectionCard";
import { SectionHead } from "@/ui/SectionHead";

import { boardFreshnessSummary, deriveSeriesFreshness } from "../lib/freshness";
import { envelopeFromSeriesRow, type SourceRating } from "../lib/provenance";
import type { GroupState, ProducerGroup, SeriesBoard as Board } from "../lib/series-board";

import { FreshnessBadge, FreshnessPanel } from "./SeriesFreshness";
import { ProvenanceDrawer } from "./Provenance";
import styles from "./market.module.css";

const STATE: Record<GroupState, string> = { not_built: "Not collected yet", registered_unpopulated: "Registered, no observations yet", populated: "Live" };

function ProducerCard({ group, ratings, nowIso, lineage }: { group: ProducerGroup; ratings: Record<string, SourceRating>; nowIso: string; lineage: Set<string> | null }) {
  const quiet = group.state !== "populated";
  return (
    <div className={`${styles.producer} ${quiet ? styles.producerQuiet : ""}`}>
      <div className={styles.producerHead}>
        <p className={styles.producerName}>{group.name}</p>
        <span className={styles.stateLabel}>{STATE[group.state]}</span>
      </div>
      <p className={styles.muted}>{group.cadence}</p>
      {quiet ? (
        <p className={styles.quietNote}>{group.state === "not_built" ? "A source this product intends to carry; nothing is collected from it yet." : "Collection is set up for this series; nothing has landed yet."}</p>
      ) : (
        <div className={styles.seriesList}>
          {group.series.map((s) => {
            const rating = s.sourceKey ? (ratings[s.sourceKey] ?? null) : null;
            const hasChange = typeof s.deltas.delta1w?.value === "number";
            return (
              <div key={s.seriesKey} className={styles.seriesRow}>
                <div className={styles.seriesLine}>
                  <span className={styles.seriesLabel}>{s.label}</span>
                  <span className={styles.seriesValue} title={s.emptyReason ?? undefined}>
                    {s.displayValue}
                  </span>
                </div>
                <p className={styles.muted}>
                  {s.referencePeriod ? `period ${s.referencePeriod}` : "no reference period"}
                  {s.observationCount > 1 ? ` · ${s.observationCount} observations on record` : ""}
                </p>
                <div className={styles.seriesLine}>
                  <FreshnessBadge freshness={deriveSeriesFreshness({ as_at_date: s.asAtDate, reference_period: s.referencePeriod }, group, nowIso)} />
                  {rating?.tier != null ? <TierChip tier={rating.tier} /> : <span className="cl-absence">Unrated</span>}
                </div>
                <ProvenanceDrawer envelope={{ ...envelopeFromSeriesRow(s, group, rating), changeRecorded: lineage && hasChange && s.id ? lineage.has(s.id) : null }} />
              </div>
            );
          })}
        </div>
      )}
      <p className={styles.sourceLine}>
        Source:{" "}
        {group.sourceUrl ? (
          <a href={group.sourceUrl} target="_blank" rel="noopener noreferrer" className={styles.provLink}>
            {group.sourceName}
          </a>
        ) : (
          group.sourceName
        )}
      </p>
    </div>
  );
}

export function SeriesBoard({ board, ratings, nowIso, lineage = null }: { board: Board; ratings: Record<string, SourceRating>; nowIso: string; lineage?: Set<string> | null }) {
  return (
    <SectionCard as="section" dataAudit="market-series-board">
      <SectionHead title="Market series board" aside={`${board.totalObservedSeries} observed series · ${board.implementedProducerCount}/${board.totalProducers} sources collected`} />
      <div className={styles.cardBody}>
        <p className={styles.muted}>Dated, sourced observations grouped by the source that publishes them: the raw time series behind the price signals, not a re-derived summary. Every source this product intends to carry is listed, whether or not it has written a row yet.</p>
        <FreshnessPanel summary={boardFreshnessSummary(board, nowIso)} />
        <div className={styles.producerGrid}>
          {board.groups.map((g) => (
            <ProducerCard key={g.keyPrefix} group={g} ratings={ratings} nowIso={nowIso} lineage={lineage} />
          ))}
        </div>
        {board.unregistered.length > 0 && (
          <div className={`${styles.producer} ${styles.producerQuiet}`}>
            <p className={styles.producerName}>
              {board.unregistered.length} series from a source not yet listed
            </p>
            <p className={styles.muted}>{board.unregistered.map((s) => s.seriesKey).join(" · ")}</p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
