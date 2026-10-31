// Ported from old_repo/src/components/market/MarketComparativeRibbon.tsx (lines 1-107)
// Ported from old_repo/src/components/market/MarketComparativeRibbon.tsx (lines 252-606)
// The headline series card (spec 02 row 1): the 15-second "has anything moved" read. Five family cards, then the rest on the same row (a strip scrolled sideways, never dropped), each with its value, 1w / 1m / YoY change, one-year
// trend, as-of date, freshness and the rating of its source. ONE methodology drawer under the strip; the panel is the worst freshness on the board. Everything it shows comes from headlineCardView.
import Link from "next/link";

import { TierChip } from "@/ui";
import { WhyMatters } from "@/ui/flywheel/FlywheelRadar";
import { SectionCard } from "@/ui/SectionCard";

import { boardFreshnessSummary } from "../lib/freshness";
import { headlineCaption, selectHeadlineSeries } from "../lib/headline";
import { headlineCardView, type HeadlineCardView } from "../lib/headline-view";
import type { SourceRating } from "../lib/provenance";
import { SPARK_H, SPARK_W, type DeltaCellModel } from "../lib/ribbon-model";
import type { SeriesBoard } from "../lib/series-board";

import { FreshnessBadge, FreshnessPanel } from "./SeriesFreshness";
import { ProvenanceFields } from "./Provenance";
import styles from "./market.module.css";

/** One slot: a number, or the state it is in, in words, with its SDMX code and the reason on hover (never a bare dash). */
function Cell({ cell, audit }: { cell: DeltaCellModel; audit: string }) {
  if (cell.kind === "absent") {
    return (
      <span data-audit={audit} data-absence-state={cell.state} data-obs-status={cell.obsStatus} aria-label={`${cell.lead}: ${cell.label}. ${cell.detail}`} title={cell.detail} className={`cl-absence ${styles.cellAbsent}`}>
        {cell.lead} · {cell.label.charAt(0).toUpperCase() + cell.label.slice(1)}
      </span>
    );
  }
  return (
    <span data-audit={audit} title={cell.fromDate ? `vs ${cell.fromDate}` : undefined} className={styles.cell}>
      {cell.text}
    </span>
  );
}

function RibbonCard({ v }: { v: HeadlineCardView }) {
  return (
    <div data-audit="headline-card" data-guard-tile="" className={styles.hCard}>
      <p data-audit="headline-card-label" data-guard-title className={styles.hLabel} title={v.label}>
        {v.label}
        {v.fold.count > 0 && (
          <span>
            {" "}
            +{v.fold.count} {v.fold.noun}
          </span>
        )}
      </p>
      <div data-audit="headline-card-value-row" className={styles.hValueRow}>
        {"cell" in v.value ? <Cell cell={v.value.cell} audit="headline-card-value" /> : <span className={styles.hValue}>{v.value.text}</span>}
        <Cell cell={v.w1} audit="headline-card-delta" />
      </div>
      <div data-audit="headline-card-windows" className={styles.hWindows}>
        <Cell cell={v.m1} audit="headline-card-delta-1m" />
        <Cell cell={v.yoy} audit="headline-card-delta-yoy" />
      </div>
      <div data-audit="headline-card-spark" className={styles.hSpark}>
        {v.spark ? (
          <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" width="100%" height={SPARK_H} role="img" aria-label={`Trend over the last year, ${v.spark.total} observations, ${v.spark.from} to ${v.spark.to}`} className={styles.sparkSvg}>
            <title>{`Last year: ${v.spark.total} observations, ${v.spark.from} to ${v.spark.to}`}</title>
            <polyline points={v.spark.points} fill="none" stroke="var(--ink-2)" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <Cell cell={v.sparkAbsent} audit="headline-card-spark-absent" />
        )}
      </div>
      <p data-audit="headline-card-asof" className={styles.hAsOf}>
        {v.asOf ? `as of ${v.asOf}` : <Cell cell={v.asOfAbsent} audit="headline-card-asof-absent" />}
      </p>
      {v.envelope.sourceRef ? (
        <p data-audit="headline-card-source" className={styles.hAsOf}>
          {v.envelope.sourceUrl ? (
            <a href={v.envelope.sourceUrl} target="_blank" rel="noopener noreferrer" className={styles.hSource}>
              {v.envelope.sourceRef}
            </a>
          ) : (
            v.envelope.sourceRef
          )}
        </p>
      ) : null}
      <div className={styles.hFoot}>
        <FreshnessBadge freshness={v.freshness} showAsOf={false} />
        {v.tier != null ? <TierChip tier={v.tier} /> : <span className="cl-absence">Unrated</span>}
      </div>
      <WhyMatters lines={v.why} />
    </div>
  );
}

export function HeadlineSeries({ board, ratings, nowIso, why = null }: { board: SeriesBoard; ratings: Record<string, SourceRating>; nowIso: string; why?: Record<string, string[]> | null }) {
  const selection = selectHeadlineSeries(board);
  if (selection.visible.length === 0) return null;
  // One row: the first five on the visible track, the rest reachable by scrolling it sideways. The cap is not applied again here.
  const views = selection.cards.map((c) => headlineCardView(c, { ratings, nowIso, why }));
  return (
    <SectionCard dataAudit="headline-series" dataAttributes={{ "data-sec-theme": "summary" }}>
      <div className={`${styles.hHead} cl-sec-head`}>
        <h2 className={styles.hTitle}>Headline series</h2>
        <span className={styles.hCaption}>
          {headlineCaption(selection)} · dated, sourced observations ·{" "}
          <Link href="/market/series" prefetch={false} className={styles.hLink}>
            Series board →
          </Link>
        </span>
      </div>
      <p className="cl-detail-section-explainer-bar">Primary freight, bunker, carbon allowance, and energy benchmarks tracked with dated source provenance and rolling windows.</p>
      <div className={styles.hTrack} data-audit="headline-track" data-overflow-allowed="" data-guard-strip="">
        {views.map((v) => (
          <RibbonCard key={v.key} v={v} />
        ))}
      </div>
      <div data-audit="headline-footer" className={styles.hFooter}>
        <FreshnessPanel summary={boardFreshnessSummary(board, nowIso)} />
        <details data-audit="headline-method-drawer" className={styles.drawer}>
          <summary className={styles.drawerSummary}>Methodology &amp; provenance for these series</summary>
          <div className={styles.methodBlocks}>
            {views.map((v) => (
              <div key={v.key} data-audit="headline-method-block">
                <p className={styles.methodName}>{v.seriesLabel}</p>
                <ProvenanceFields envelope={v.envelope} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </SectionCard>
  );
}
