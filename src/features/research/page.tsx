// Ported from old_repo/src/app/research/page.tsx (lines 84-138)
import { userClient } from "@/core/db/clients";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/ui/shell";
import { loadSurfaceDenominator } from "@/features/coverage/server/matrix-data";

import { readResearchPage } from "./read/research-reads";
import { readThemeStrip } from "./read/theme-strip";
import { ResearchList } from "./ui/ResearchList";

/** /research: the session and its one instant, then the page's reads on the caller's own client; each read reports its own failure to the list, which says so with Retry. */
export async function ResearchRoute() {
  const session = await pageSession("/research");
  if ("failed" in session) return <PageFailure what="Research" />;
  const db = await userClient();
  const [data, denominator, strip] = await Promise.all([readResearchPage(db, session.orgId), loadSurfaceDenominator("research", { db: () => db }), readThemeStrip(db, "research")]);
  return <ResearchList data={data} nowIso={session.nowIso} chips={strip.chips} chipsFailed={strip.failed} denominator={{ ...denominator, surfacePath: "/research" }} />;
}
