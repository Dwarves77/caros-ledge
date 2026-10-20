// Ported from old_repo/src/components/list-surface/ListSurfaceRailCards.tsx (lines 377-549)
// Ported from old_repo/src/components/market/MarketIntelLedger.tsx (lines 329-353)
// The market rail, in artboard 04's order after the Filters card the list surface draws first: Carbon cost per FEU (only while a corridor has a figure), Next data drops, Legend, then Sources tracked (an app card the artboard does not draw, kept after the last designed card).
// Each card is a read of the same board the page already holds: no second request, no second computation.
import { formatDate } from "@/core/shared";
import { RailCard } from "@/ui";
import { LegendRailCard } from "@/ui/list-surface";

import type { NextDrop } from "../lib/rail-select";
import type { SeriesBoard } from "../lib/series-board";

import { RetryNote } from "./RetryNote";
import styles from "./market.module.css";

export function MarketRail({ drops, board }: { drops: NextDrop[] | null; board: SeriesBoard | null }) {
  return (
    <>
      <RailCard title="Next data drops" dataAudit="next-drops-rail">
        {drops === null ? (
          <RetryNote what="Data drop dates" />
        ) : drops.length === 0 ? (
          <p className="cl-absence">No date to show</p>
        ) : (
          <div className={styles.railRows}>
            {drops.map((d) => (
              <div key={d.keyPrefix} className={styles.railRow}>
                <span className={styles.railName}>{d.name}</span>
                <span className={styles.railValue}>{formatDate(d.dateIso)}</span>
              </div>
            ))}
          </div>
        )}
      </RailCard>
      <LegendRailCard />
      <RailCard title="Sources tracked" dataAudit="sources-rail">
        {board === null ? (
          <RetryNote what="The source list" />
        ) : board.groups.length === 0 ? (
          <p className="cl-absence">No sources to list</p>
        ) : (
          <div className={styles.railRows}>
            {board.groups.map((g) => (
              <div key={g.keyPrefix} className={styles.railRow}>
                <span className={styles.railName}>{g.name}</span>
                <span className={styles.muted}>{g.cadence}</span>
              </div>
            ))}
          </div>
        )}
      </RailCard>
    </>
  );
}
