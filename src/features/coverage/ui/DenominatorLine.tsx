// Ported from old_repo/src/components/coverage/CoverageDenominatorLine.tsx (lines 1-8)
// Ported from old_repo/src/components/coverage/CoverageDenominatorLineView.tsx (lines 1-66)
import Link from "next/link";

import type { DenominatorLine as Denominator } from "@/core/coverage/matrix";
import { Absence } from "@/ui";

import { denominatorLineView } from "../denominator-view";
import { RequestableCoverageState } from "../client";

/**
 * The line a surface shows under its masthead: numerator and denominator side by side, the separate verified-brief count, and the link to the cell. The link is ALWAYS drawn. A refused or failed read shows the
 * Absence token with a stated note beside it; a surface with nothing catalogued (a successful read of zero) says "not covered" with the request control. `surfacePath` is the page's own path ("/research"),
 * which names the coverage class when the count did not load.
 */
export function DenominatorLine({ denominator, error, surfacePath }: { denominator: Denominator | null; error: string | null; surfacePath: string }) {
  const v = denominatorLineView(denominator, error, surfacePath.replace(/^\//, ""));
  return (
    <div data-guard-container="coverage-denominator">
      {v.state === "empty-catalogue" && denominator ? (
        <RequestableCoverageState state="not_covered" variant="inline" subject={`The ${denominator.label} catalogue`} reason="No instrument has been catalogued for this surface yet." requestRef={denominator.href} />
      ) : null}
      <p data-part="coverage-denominator" className="cl-coverage-line">
        {v.state === "unavailable" ? (
          <span role="alert" data-part="state-note">
            Coverage count: <Absence reason="connect data" variant="dash" /> It did not load; the coverage page has the full count.
          </span>
        ) : (
          <span>{v.text}</span>
        )}{" "}
        <Link href={v.href} prefetch={false} className="cl-coverage-link">
          See coverage
        </Link>
      </p>
    </div>
  );
}
