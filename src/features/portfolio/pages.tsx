// Ported from old_repo/src/app/dashboard/portfolio/page.tsx (lines 15-33)
// Ported from old_repo/src/app/dashboard/portfolio/[id]/page.tsx (lines 17-37)
import { notFound } from "next/navigation";

import { userClient } from "@/core/db/clients";
import { formatLocaleDate } from "@/core/shared";
import { log } from "@/core/shared/log";
import { canWrite } from "@/core/workspace";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/features/account/ui/PageFailure";
import { listPortfolios } from "@/features/workspace/portfolio/core";
import { readPortfolioDetail } from "@/features/workspace/portfolio/read";
import type { PortfolioDetailView as Detail, PortfolioSummary } from "@/features/workspace/portfolio/types";

import { portfolioDeps } from "./deps";
import { PortfolioDetailView } from "./ui/PortfolioDetailView";
import { PortfolioIndexView } from "./ui/PortfolioIndexView";

const label = (iso: string) => formatLocaleDate(new Date(iso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const settle = async <T,>(what: string, run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch (e) {
    log.warn(`[portfolio] ${what} read failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
};

/** /dashboard/portfolio: the workspace's portfolios on the caller's own client. A failed read is the unavailable state with Retry; a reader with no workspace is sent to set one up. */
export async function PortfolioIndexRoute() {
  const session = await pageSession("/dashboard/portfolio");
  if ("failed" in session) return <PageFailure what="Portfolios" />;
  const rows: PortfolioSummary[] | null = session.orgId ? await settle("index", async () => listPortfolios(await userClient(), session.orgId as string)) : [];
  return <PortfolioIndexView portfolios={rows ?? []} unavailable={rows === null} readOnly={!canWrite(session.role)} dateLabel={label(session.nowIso)} nowIso={session.nowIso} />;
}

/** /dashboard/portfolio/[id]: one portfolio with its roll-ups. Another workspace's id is a 404 exactly like a missing one; a failed read is the unavailable state, never a 404. */
export async function PortfolioDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await pageSession(`/dashboard/portfolio/${encodeURIComponent(id)}`);
  if ("failed" in session) return <PageFailure what="This portfolio" />;
  if (!session.orgId) notFound();
  const db = await userClient();
  const view: Detail | null | undefined = await settle("detail", async () => (await readPortfolioDetail(db, session.orgId as string, id, new Date(session.nowIso), portfolioDeps(db))) ?? undefined).then((v) => (v === null ? null : (v ?? undefined)));
  if (view === undefined) notFound();
  if (view === null) return <PortfolioIndexView portfolios={[]} unavailable readOnly dateLabel={label(session.nowIso)} nowIso={session.nowIso} />;
  return <PortfolioDetailView view={view} readOnly={!canWrite(session.role)} dateLabel={label(session.nowIso)} nowIso={session.nowIso} />;
}
