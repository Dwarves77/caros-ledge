// Ported from old_repo/src/app/operations/page.tsx (lines 34-63)
import { userClient } from "@/core/db/clients";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/ui/shell";
import { loadSurfaceDenominator } from "@/features/coverage/server";
import { readThemeStrip } from "@/features/research/read/theme-strip";

import { readOperationsPage } from "./read/operations-reads";
import { OperationsList } from "./ui/OperationsList";

/** /operations: the session and its one instant, then the page's reads on the caller's own client; the matrix, the statements and each rail card report their own failure. */
export async function OperationsRoute() {
  const session = await pageSession("/operations");
  if ("failed" in session) return <PageFailure what="Operations" />;
  const db = await userClient();
  const [data, denominator, strip] = await Promise.all([readOperationsPage(db, session.nowIso, session.orgId), loadSurfaceDenominator("operations", { db: () => db }), readThemeStrip(db, "operations")]);
  return <OperationsList data={data} nowIso={session.nowIso} chips={strip.chips} chipsFailed={strip.failed} denominator={{ ...denominator, surfacePath: "/operations" }} />;
}
