// Ported from old_repo/src/components/coverage/CoverageDenominatorLineView.tsx (lines 1-66)
// The per-surface coverage line under a list (numerator beside denominator, the verified-brief count, the link to the cell), built on the coverage model's own words (core/coverage). A failed read says so with
// Retry (a link back to the page); an empty catalogue names what it needs. The coverage slice's shared line (P2-14) replaces this one when it lands; the words come from the same model either way.
import Link from "next/link";

import { formatDenominatorLine } from "@/core/coverage";
import type { DenominatorLine } from "@/core/coverage/matrix";
import { CoverageState } from "@/ui";

import styles from "./research.module.css";

export function CoverageLine({ denominator, error, surfacePath }: { denominator: DenominatorLine | null; error: string | null; surfacePath: string }) {
  if (error || !denominator) return <CoverageState state="error" variant="inline" subject="The coverage count" retryHref={surfacePath} />;
  if (denominator.denominator === 0) return <CoverageState state="not_covered" variant="inline" subject={`The ${denominator.label} catalogue`} reason="No instrument has been catalogued for this surface yet." requestRef={denominator.href} />;
  return (
    <p data-part="coverage-denominator" className={styles.coverageLine}>
      <span>{formatDenominatorLine(denominator)}</span>
      <Link href={denominator.href} className={styles.coverageLink}>
        See coverage
      </Link>
    </p>
  );
}
