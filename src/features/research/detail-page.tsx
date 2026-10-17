// Ported from old_repo/src/app/research/[slug]/page.tsx (lines 95-314)
import { notFound } from "next/navigation";

import { applyIdRedirect, loadDetail, type ItemScopedCtx } from "@/core/detail";
import { isServiceConfigured, serviceClient } from "@/core/db";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/features/account/ui/PageFailure";

import { readAssessmentBundle } from "./read/research-reads";
import { relatedItems } from "./read/related-items";
import { ResearchDetail } from "./ui/ResearchDetail";

/**
 * The item-scoped reads of a finding: the related findings (the same theme first, then the same source) and the assessment bundle. The raw assessments table is closed to a signed-in client (the current view is
 * open), so the history chain is walked on the service client when one is configured; a session without one shows a chain that says it is shorter than the real one.
 */
const loadFinding = async ({ db, uuid, resource }: ItemScopedCtx) => {
  const [related, assessment] = await Promise.all([
    relatedItems(db, { id: uuid, sourceId: resource.sourceId ?? null }, resource.theme ? (q) => q.eq("theme", resource.theme as string) : null),
    readAssessmentBundle(db, uuid, isServiceConfigured() ? serviceClient() : db),
  ]);
  return { related, assessment };
};

/** /research/[slug]: a uuid URL lands on the page that renders it (or on not-found), the detail loads on the caller's client, a failed read throws to the route's error page with Retry. */
export async function ResearchDetailRoute({ params }: { params: Promise<{ slug: string }> }) {
  const id = decodeURIComponent((await params).slug);
  await applyIdRedirect("research", id);
  const session = await pageSession(`/research/${encodeURIComponent(id)}`);
  if ("failed" in session) return <PageFailure what="This finding" />;
  const d = await loadDetail("research", id, loadFinding);
  if (d.notFound) notFound();
  return <ResearchDetail resource={d.resource} sections={d.sections} claimTiers={d.claimTiers} recommendedActions={d.recommendedActions} connectionRows={d.connectionRows} crossPage={d.crossPage} related={d.itemScoped.related} assessment={d.itemScoped.assessment} nowIso={session.nowIso} />;
}
