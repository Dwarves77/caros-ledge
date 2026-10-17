// Ported from old_repo/src/app/dashboard/coverage/page.tsx (lines 1-22)
import { buildCoverageView, parseCoverageQuery } from "@/core/coverage/matrix";
import { PageFailure } from "@/features/account/ui/PageFailure";
import { pageSession } from "@/features/account/server/page-session";

import { coverageData } from "./server/data";
import { CoveragePage } from "./ui/CoveragePage";

export const COVERAGE_PATH = "/dashboard/coverage";

/** The /dashboard/coverage server gate: the session, the matrix (cached, an outage never cached) and the view for the query. A failed session lookup is a failure page with Retry. */
export default async function CoverageRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseCoverageQuery(await searchParams);
  const session = await pageSession(COVERAGE_PATH);
  if ("failed" in session) return <PageFailure what="Coverage" />;
  const { matrix, error } = await coverageData.getCoverageMatrix();
  return <CoveragePage matrix={matrix} view={buildCoverageView(matrix, query)} query={query} error={error} nowIso={session.nowIso} />;
}
