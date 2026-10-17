// Ported from old_repo/src/components/coverage/CoverageDenominatorLine.tsx (lines 1-8)
// Ported from old_repo/src/components/coverage/CoverageDenominatorLineView.tsx (lines 1-66)
import Link from "next/link";

import { formatDenominatorLine, type DenominatorLine as Denominator } from "@/core/coverage/matrix";
import { CoverageState } from "@/ui";

import { RequestableCoverageState } from "../client";

/**
 * The line a surface shows under its masthead: numerator and denominator side by side, the separate verified-brief count, and the link to the cell. A failed read is the error state with Retry (never a zero), and
 * a surface with nothing catalogued says "not covered" with the request control. `surfacePath` is the page's own path, the target of Retry.
 */
export function DenominatorLine({ denominator, error, surfacePath }: { denominator: Denominator | null; error: string | null; surfacePath: string }) {
  if (error || !denominator) {
    return (
      <div data-guard-container="coverage-denominator">
        <CoverageState state="error" variant="inline" subject="The coverage count" retryHref={surfacePath} />
      </div>
    );
  }
  if (denominator.denominator === 0) {
    return (
      <div data-guard-container="coverage-denominator">
        <RequestableCoverageState state="not_covered" variant="inline" subject={`The ${denominator.label} catalogue`} reason="No instrument has been catalogued for this surface yet." requestRef={denominator.href} />
      </div>
    );
  }
  return (
    <div data-guard-container="coverage-denominator">
      <p data-part="coverage-denominator" className="cl-coverage-line">
        <span>{formatDenominatorLine(denominator)}</span> <Link href={denominator.href} className="cl-coverage-link">See coverage</Link>
      </p>
    </div>
  );
}
