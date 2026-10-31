// Ported from old_repo/src/app/operations/[slug]/page.tsx (lines 95-275)
import { notFound } from "next/navigation";

import { applyIdRedirect, loadDetail, type ItemScopedCtx } from "@/core/detail";
import { pageSession } from "@/features/account/server/page-session";
import { log } from "@/core/shared";
import { PageFailure } from "@/ui/shell";
import { relatedItems } from "@/features/research/read/related-items";
import { KIND_LABELS, readUpcoming } from "@/features/obligations";

import { profileScope, readDerivedFigures, readItemRegionInputs, readMatrixEligibility, readRoster, readSpec09 } from "./read/operations-reads";
import { OperationsDetail } from "./ui/OperationsDetail";

/**
 * The item-scoped reads of a regional profile: the S3/S4 gate over the item's WHOLE jurisdiction list, the related profiles (the same jurisdictions first, then the same source), the workspace's loads and the
 * grid queue, and the figures the flywheel recomputed. Each reports its own failure; none is dropped.
 */
const loadProfile = (orgId: string | null, today: string) => async ({ db, uuid }: ItemScopedCtx) => {
  const [item, roster, events] = await Promise.all([
    readItemRegionInputs(db, uuid),
    readRoster(db),
    readUpcoming(db, { itemId: uuid, limit: 20 }, today).catch((e: unknown) => (log.warn("[operations] obligation events read failed:", e instanceof Error ? e.message : String(e)), null)),
  ]);
  const scope = profileScope(item, roster);
  const [eligibility, related, spec09, derived] = await Promise.all([
    readMatrixEligibility(db, item, roster),
    relatedItems(db, { id: uuid, sourceId: item.sourceId }, item.jurisdictions && item.jurisdictions.length > 0 ? (q) => q.contains("jurisdictions", [...item.jurisdictions as string[]]).eq("item_type", "regional_data") : null),
    readSpec09(db, orgId, scope),
    readDerivedFigures(db, scope).catch((e) => (log.warn("[operations] recomputed figures did not load:", e instanceof Error ? e.message : String(e)), null)),
  ]);
  return { eligibility, related, spec09, derived, events };
};

/** /operations/[slug]: a uuid URL lands on the page that renders it (or on not-found), the profile loads on the caller's client, a failed read throws to the route's error page with Retry. */
export async function OperationsDetailRoute({ params }: { params: Promise<{ slug: string }> }) {
  const id = decodeURIComponent((await params).slug);
  const [, session] = await Promise.all([applyIdRedirect("operations", id), pageSession(`/operations/${encodeURIComponent(id)}`)]);
  if ("failed" in session) return <PageFailure what="This profile" />;
  const d = await loadDetail("operations", id, loadProfile(session.orgId, session.nowIso.slice(0, 10)), undefined, session.orgId, session.nowIso);
  if (d.notFound) notFound();
  const { events } = d.itemScoped;
  return <OperationsDetail resource={d.resource} sections={d.sections} claimTiers={d.claimTiers} claimsDegraded={d.claimsDegraded} recommendedActions={d.recommendedActions} connectionRows={d.connectionRows} crossPage={d.crossPage} related={d.itemScoped.related} eligibility={d.itemScoped.eligibility} spec09={d.itemScoped.spec09} derived={d.itemScoped.derived} events={events?.events ?? []} eventsFailed={events === null} kindLabels={KIND_LABELS} nowIso={session.nowIso} />;
}
