// Ported from old_repo/src/app/operations/[slug]/page.tsx (lines 95-275)
import { notFound } from "next/navigation";

import { applyIdRedirect, loadDetail, type ItemScopedCtx } from "@/core/detail";
import { pageSession } from "@/features/account/server/page-session";
import { log } from "@/core/shared";
import { PageFailure } from "@/ui/shell";
import { relatedItems } from "@/features/research/read/related-items";

import { readDerivedFigures, readItemRegionInputs, readMatrixEligibility, readSpec09 } from "./read/operations-reads";
import { regionsForItem } from "./model/region-resolve";
import { readRoster } from "./read/operations-reads";
import { OperationsDetail } from "./ui/OperationsDetail";

/**
 * The item-scoped reads of a regional profile: the S3/S4 gate over the item's WHOLE jurisdiction list, the related profiles (the same jurisdictions first, then the same source), the workspace's loads and the
 * grid queue, and the figures the flywheel recomputed. Each reports its own failure; none is dropped.
 */
const loadProfile = (orgId: string | null) => async ({ db, uuid }: ItemScopedCtx) => {
  const item = await readItemRegionInputs(db, uuid);
  // The roster is read ONCE for the profile and handed down; a failed read throws to the page failure (with Retry), never an empty roster that resolves no region (register surfaces:32).
  const roster = await readRoster(db);
  const regionCodes = regionsForItem(roster.map((r) => ({ code: r.code, isoCodes: r.isoCodes })), item);
  const [eligibility, related, spec09, derived] = await Promise.all([
    readMatrixEligibility(db, item, roster),
    relatedItems(db, { id: uuid, sourceId: item.sourceId }, item.jurisdictions && item.jurisdictions.length > 0 ? (q) => q.contains("jurisdictions", [...item.jurisdictions as string[]]).eq("item_type", "regional_data") : null),
    readSpec09(db, orgId, regionCodes, roster),
    readDerivedFigures(db).catch((e) => (log.warn("[operations] recomputed figures did not load:", e instanceof Error ? e.message : String(e)), null)),
  ]);
  return { eligibility, related, spec09, derived };
};

/** /operations/[slug]: a uuid URL lands on the page that renders it (or on not-found), the profile loads on the caller's client, a failed read throws to the route's error page with Retry. */
export async function OperationsDetailRoute({ params }: { params: Promise<{ slug: string }> }) {
  const id = decodeURIComponent((await params).slug);
  await applyIdRedirect("operations", id);
  const session = await pageSession(`/operations/${encodeURIComponent(id)}`);
  if ("failed" in session) return <PageFailure what="This profile" />;
  const d = await loadDetail("operations", id, loadProfile(session.orgId));
  if (d.notFound) notFound();
  return <OperationsDetail resource={d.resource} sections={d.sections} claimTiers={d.claimTiers} claimsDegraded={d.claimsDegraded} recommendedActions={d.recommendedActions} connectionRows={d.connectionRows} crossPage={d.crossPage} related={d.itemScoped.related} eligibility={d.itemScoped.eligibility} spec09={d.itemScoped.spec09} derived={d.itemScoped.derived} nowIso={session.nowIso} />;
}
