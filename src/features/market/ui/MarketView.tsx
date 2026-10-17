// Ported from old_repo/src/app/market/page.tsx (lines 116-249)
// The /market page as a pure view of what the reader returned: the ledger with the headline card, the rail and the foot; then the carbon overlay, the lead-time chart, the policy timeline, the notices and the three panels. Every part is
// independent: a failed read is that part's note with Retry, the rest of the page stands. The page reads and renders this; the UX fixtures render this with fixed data.
import { Suspense } from "react";

import type { DenominatorLine } from "@/core/coverage/matrix";
import { trimRemainder } from "@/core/lists";
import { NoticesRail } from "@/ui/figures";
import { ThemeStrip, type ThemeChip } from "@/ui/list-surface";

import { selectNextDataDrops, summariseCarbonCorridors } from "../lib/rail-select";
import type { MarketRead } from "../read";

import { CarbonCostOverlay } from "./CarbonCostOverlay";
import { CoverageLine } from "./CoverageLine";
import { HeadlineSeries } from "./HeadlineSeries";
import { LeadTimeChart } from "./LeadTimeChart";
import { MarketLedger } from "./MarketLedger";
import { PolicyTimeline } from "./PolicyTimeline";
import { MarketRail } from "./Rails";
import { RetryNote } from "./RetryNote";
import { Spec09Panels } from "./Spec09Panels";
import styles from "./market.module.css";


export interface MarketViewProps {
  read: MarketRead;
  nowIso: string;
  coverage: { denominator: DenominatorLine | null; failed: boolean };
  /** The theme strip's chips; null when that read failed. */
  chips: ThemeChip[] | null;
}

export function MarketView({ read, nowIso, coverage, chips }: MarketViewProps) {
  const { signals, series, corridors, panels } = read;
  const board = series.ok ? series.data.board : null;
  const labels = corridors.ok ? Object.fromEntries(corridors.data.map((c) => [c.entityId, c.label])) : {};
  return (
    <>
      <Suspense fallback={null}>
        <MarketLedger
          resources={signals.ok ? signals.data.rows.map(trimRemainder) : []}
          aggregates={signals.ok ? signals.data.aggregates : null}
          failed={!signals.ok}
          nowIso={nowIso}
          seriesCount={board ? board.totalObservedSeries : null}
          headline={board && series.ok ? <HeadlineSeries board={board} ratings={series.data.ratings} nowIso={nowIso} /> : <RetryNote what="The headline series" />}
          rail={<MarketRail carbon={corridors.ok ? summariseCarbonCorridors(corridors.data) : null} drops={board ? selectNextDataDrops(board, { now: new Date(nowIso) }) : null} board={board} />}
          belowRows={
            <>
              {chips === null ? <RetryNote what="The theme strip" /> : <ThemeStrip chips={chips} />}
              <CoverageLine denominator={coverage.denominator} failed={coverage.failed} />
            </>
          }
        />
      </Suspense>
      {corridors.ok ? <CarbonCostOverlay overlays={corridors.data} /> : <div className={styles.band}><RetryNote what="Carbon cost per FEU" /></div>}
      {series.ok ? <LeadTimeChart rows={series.data.leadTime} /> : <div className={styles.band}><RetryNote what="The lead-time position" /></div>}
      <Suspense fallback={null}>
        <PolicyTimeline />
      </Suspense>
      <div className={styles.band}>
        <NoticesRail />
      </div>
      <Spec09Panels panels={panels} corridorLabels={labels} />
    </>
  );
}
