// Ported from old_repo/src/components/figures/RecalculationNotice.tsx (lines 1-131)
// Ported from old_repo/src/components/figures/NoticesRail.tsx (lines 60-133)
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { SectionCard, SectionHead, StateNote } from "@/ui";

import type { NoticesRead, WatchNotice } from "../read/notices";

import styles from "./watchlist.module.css";

const when = (iso: string): string => formatLocaleDate(new Date(iso), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const figure = (v: number | null, unit: string | null, currency: string | null): string => (v === null || !Number.isFinite(v) ? "—" : `${currency ? `${currency} ` : ""}${formatNumber(v, { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 })}${currency || !unit ? "" : ` ${unit}`}`);

function Notice({ n }: { n: WatchNotice }) {
  return (
    <li className={styles.notice}>
      <div className={styles.noticeHead}>
        <span className={styles.noticeLabel}>{n.entityLabel ?? "A watched figure"}</span>
        <span className={styles.noticeMeta}>{when(n.supersededAt)}</span>
      </div>
      <div className={styles.noticeDelta}>
        {figure(n.oldValue, n.unit, n.currency)} → {figure(n.newValue, n.unit, n.currency)}
      </div>
      <div className={styles.noticeMeta}>Recalculated after an input it depends on changed.</div>
    </li>
  );
}

/** The Recalculation notices card: the workspace's watched figures that were recalculated in the window. Three honest states: the notices, none in the window, and a read that failed (with Retry). */
export function NoticesCard({ read, onRetry }: { read: NoticesRead | null; onRetry: () => void }) {
  return (
    <div id="recalculation-notices" data-audit="recalculation-notices">
      <SectionCard>
        <SectionHead title="Recalculation notices" aside={read ? `Since ${when(read.since)}` : "Recent changes"} />
        {read === null ? (
          <div className="cl-pad-16">
            <StateNote tone="error" action={{ label: "Retry", onClick: onRetry }}>
              Recalculation notices did not load. Nothing was lost; try again.
            </StateNote>
          </div>
        ) : read.notices.length === 0 ? (
          <div className="cl-pad-16">
            <StateNote>No recalculations on watched items in this window.</StateNote>
          </div>
        ) : (
          <ul className={styles.list}>
            {read.notices.map((n) => (
              <Notice key={n.newValueId} n={n} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
