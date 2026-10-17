"use client";

// Ported from old_repo/src/components/admin/redesign/AdminIssuesRail.tsx (lines 43-252)
import { formatNumber } from "@/core/shared";
import { RailCard } from "@/ui";

import type { AttentionCounts } from "../api/attention";

import { issueRows, issueTotal, type IssueNavTarget } from "./console-math";
import styles from "./admin.module.css";

/**
 * The issues queue. A count that has not been read is not drawn as zero: the rail says it is unknown. A zero row stays quiet and is not a control (a zero is a fact, not an alarm); every other row is a
 * 44 px button that opens its queue.
 */
export function IssuesRail({ counts, failed, onNavigate, onRetry }: { counts: AttentionCounts | null; failed?: string | null; onNavigate: (t: IssueNavTarget) => void; onRetry?: () => void }) {
  const rows = counts ? issueRows(counts) : [];
  const total = issueTotal(rows);
  return (
    <RailCard title="Issues queue" headRight={counts ? <span className={total > 0 ? styles.railCountOn : styles.railCountOff} aria-label={`${formatNumber(total)} items need attention`}>{formatNumber(total)}</span> : null}>
      {counts ? (
        <div>
          {rows.map((r) =>
            r.count === 0 ? (
              <div key={r.key} className={styles.rowFlat} aria-disabled="true">
                <span className={styles.truncate}>{r.title}</span>
                <span className={styles.railCountOff}>0</span>
              </div>
            ) : (
              <button key={r.key} type="button" className={styles.rowBtn} aria-label={`${r.title}: ${r.count}. Open queue.`} onClick={() => onNavigate(r.target)}>
                <span className={styles.truncate}>{r.title}</span>
                <span className={styles.railCountOn}>{formatNumber(r.count)}</span>
              </button>
            ),
          )}
        </div>
      ) : (
        <p className={styles.note} role="alert">
          The queue did not load{failed ? `: ${failed}` : ""}. {onRetry ? <button type="button" className={styles.link} onClick={onRetry}>Retry</button> : null}
        </p>
      )}
    </RailCard>
  );
}
