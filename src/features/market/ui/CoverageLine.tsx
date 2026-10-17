// Ported from old_repo/src/components/coverage/CoverageDenominatorLineView.tsx (lines 1-62)
// The coverage denominator line a list page ends with: how many catalogued instruments are dual-verified, and the link to the cell. An unreadable count is the named error with Retry, never a zero.
import Link from "next/link";

import { formatDenominatorLine } from "@/core/coverage";
import type { DenominatorLine } from "@/core/coverage/matrix";

import { RetryNote } from "./RetryNote";
import styles from "./market.module.css";

export function CoverageLine({ denominator, failed }: { denominator: DenominatorLine | null; failed: boolean }) {
  if (failed || !denominator) return <div className={styles.coverageLine}><RetryNote what="The coverage count" /></div>;
  return (
    <p data-part="coverage-denominator" className={styles.coverageLine}>
      <span>{formatDenominatorLine(denominator)}</span>
      <Link href={denominator.href} className={styles.coverageLink}>
        See coverage
      </Link>
    </p>
  );
}
