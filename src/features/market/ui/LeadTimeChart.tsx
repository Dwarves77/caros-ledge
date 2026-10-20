// Ported from old_repo/src/components/market/LeadTimeChart.tsx (lines 1-89)
// The lead-time position (spec 02 row 5, INV-257): the SBTi cohort's months to target, bars and median. Below five usable rows it says "not forecastable" with the count and the floor, the reason the producer cannot write more
// (SBTi data may not be redistributed), never an empty box. The bar track stays at least 80 px at 375 (the label wraps above it).
import { formatNumber } from "@/core/shared";
import { SectionCard } from "@/ui/SectionCard";
import { SectionHead } from "@/ui/SectionHead";

import { buildLeadTimePosition, DEFAULT_MIN_SAMPLE, leadTimeCanHaveRows, type LeadTimeRow } from "../lib/lead-time";

import styles from "./market.module.css";

export function LeadTimeChart({ rows, minSample = DEFAULT_MIN_SAMPLE }: { rows: readonly LeadTimeRow[]; minSample?: number }) {
  if (!leadTimeCanHaveRows(rows)) return null;
  const position = buildLeadTimePosition(rows, { minSample });
  const max = position.forecastable ? Math.max(...position.rows.map((r) => r.months), 1) : 1;
  return (
    <div className={styles.band}>
      <SectionCard as="section" dataAudit="lead-time-chart">
        <SectionHead title="Lead-time position" aside="SBTi Target Dashboard" />
        <div className={styles.cardBody}>
          <p className={styles.muted}>Peer-cohort distribution of months to each company&apos;s SBTi target commitment.</p>
          {!position.forecastable ? (
            <p data-part="not-forecastable" className="cl-absence">
              Not forecastable: {position.reason} (at least {position.minSample} to draw a position).
            </p>
          ) : (
            <>
              <p className={styles.kicker}>
                Cohort median: {formatNumber(position.cohortMedianMonths as number, { maximumFractionDigits: 1 })} months · n = {position.sampleSize}
              </p>
              {position.rows.map((r) => (
                <div key={r.seriesKey} className={styles.leadRow}>
                  <span className={styles.leadLabel} title={r.label}>
                    {r.label}
                  </span>
                  <span className={styles.leadTrack}>
                    <span className={styles.leadFill} style={{ width: `${Math.max(2, (r.months / max) * 100)}%` }} />
                  </span>
                  <span className={styles.leadValue}>{formatNumber(r.months, { maximumFractionDigits: 1 })} mo</span>
                </div>
              ))}
            </>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
