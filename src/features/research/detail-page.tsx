// Ported from old_repo/src/app/research/[slug]/page.tsx (lines 95-314)
import { notFound } from "next/navigation";

import { applyIdRedirect, loadDetail, type ItemScopedCtx } from "@/core/detail";
import { pageSession } from "@/features/account/server/page-session";
import { userClient } from "@/core/db";
import { log } from "@/core/shared";
import { KIND_LABELS, readUpcoming } from "@/features/obligations";
import { PageFailure } from "@/ui/shell";

import { readAssessmentBundle } from "./read/research-reads";
import { relatedItems } from "./read/related-items";
import { ResearchDetail } from "./ui/ResearchDetail";

/** The item-scoped reads of a finding, on the caller's own client: the related findings (the same theme first, then the same source) and the assessment bundle (its history chain through research_assessment_history). */
const loadFinding = async ({ db, uuid, resource }: ItemScopedCtx) => {
  const [related, assessment] = await Promise.all([
    relatedItems(db, { id: uuid, sourceId: resource.sourceId ?? null }, resource.theme ? (q) => q.eq("theme", resource.theme as string) : null),
    readAssessmentBundle(db, uuid),
  ]);
  return { related, assessment };
};

/** /research/[slug]: a uuid URL lands on the page that renders it (or on not-found), the detail loads on the caller's client, a failed read throws to the route's error page with Retry. */
export async function ResearchDetailRoute({ params }: { params: Promise<{ slug: string }> }) {
  const id = decodeURIComponent((await params).slug);
  await applyIdRedirect("research", id);
  const session = await pageSession(`/research/${encodeURIComponent(id)}`);
  if ("failed" in session) return <PageFailure what="This finding" />;
  const d = await loadDetail("research", id, loadFinding, undefined, session.orgId, session.nowIso);
  if (d.notFound) notFound();
  const today = session.nowIso.slice(0, 10);
  const db = await userClient();
  const events = await readUpcoming(db, { itemId: d.uuid, limit: 20 }, today).catch((e: unknown) => {
    log.warn("[research] obligation events read failed:", e instanceof Error ? e.message : String(e));
    return null;
  });
  return <ResearchDetail resource={d.resource} sections={d.sections} claimTiers={d.claimTiers} claimsDegraded={d.claimsDegraded} recommendedActions={d.recommendedActions} connectionRows={d.connectionRows} crossPage={d.crossPage} related={d.itemScoped.related} assessment={d.itemScoped.assessment} events={events?.events ?? []} eventsFailed={events === null} kindLabels={KIND_LABELS} nowIso={session.nowIso} />;
}
