// Ported from old_repo/src/app/market/[slug]/page.tsx (lines 1-120)
// /market/[slug]: the id decision, the ONE detail load on the surface's own admission rule, and the market reads that ride the loader (each its own Section, so a refused read is a stated block with Retry and never a thrown page).
import { notFound, unstable_rethrow } from "next/navigation";

import { userClient } from "@/core/db";
import { applyIdRedirect, loadDetail } from "@/core/detail";
import { log } from "@/core/shared";
import { pageSession } from "@/features/account/server/page-session";
import { KIND_LABELS, readUpcoming } from "@/features/obligations";
import { PageFailure } from "@/ui/shell/PageFailure";

import { bandOf } from "./lib/signal-band";
import { readMarketDetail } from "./read";
import { MarketDetailView } from "./ui/MarketDetailView";

export async function MarketDetailRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const id = decodeURIComponent(slug);
  const session = await pageSession(`/market/${slug}`);
  if ("failed" in session) return <PageFailure what="This signal" />;
  const db = await userClient();
  const today = session.nowIso.slice(0, 10);
  const data = await (async () => {
    await applyIdRedirect("market", id, db);
    const detail = await loadDetail("market", id, ({ db: client, uuid, resource }) => readMarketDetail(client, { id: uuid, sourceId: resource.sourceId ?? null, needsCarbon: bandOf(resource) === "corridor" || resource.itemGrade === "record" }), db, session.orgId);
    if (detail.notFound) return "missing" as const;
    const events = await readUpcoming(db, { itemId: detail.uuid, limit: 20 }, today).catch((e: unknown) => {
      unstable_rethrow(e);
      log.warn("[market] obligation events read failed:", e instanceof Error ? e.message : String(e));
      return null;
    });
    return { detail, events };
  })().catch((e: unknown) => {
    unstable_rethrow(e);
    log.warn("[market] detail did not load:", e instanceof Error ? e.message : String(e));
    return null;
  });
  if (data === null) return <PageFailure what="This signal" />;
  if (data === "missing") notFound();
  const { detail, events } = data;
  return (
    <MarketDetailView
      resource={detail.resource}
      sections={detail.sections}
      claimTiers={detail.claimTiers}
      claimsDegraded={detail.claimsDegraded}
      recommendedActions={detail.recommendedActions}
      crossPage={detail.crossPage}
      connectionRows={detail.connectionRows}
      bundle={detail.itemScoped}
      events={events?.events ?? []}
      eventsFailed={events === null}
      kindLabels={KIND_LABELS}
      nowIso={session.nowIso}
    />
  );
}
