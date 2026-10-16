// Ported from old_repo/src/lib/workspace/viewer-relevance.ts (lines 1-33)
import { getClaims } from "@/core/auth/claims";
import { currentMembership } from "@/core/auth/membership";
import { userClient } from "@/core/db/clients";
import { log } from "@/core/shared/log";

import { getWorkspaceProfile } from "./profile";
import { relevanceForItem, type ItemRelevance, type RelevanceDeps } from "./relevance";

/** The subset of intelligence_items columns the lens reads. */
export interface RelevanceInput {
  title?: string | null;
  transport_modes?: string[] | null;
  jurisdictions?: string[] | null;
  jurisdiction_iso?: string[] | null;
  topic_tags?: string[] | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
}

/**
 * The lens for the signed-in viewer's workspace, or null. It fails soft (a lens failure must never fail a detail page) but never silently:
 * the cause is logged. The profile is read on the viewer's own client (settings_read_org).
 */
export async function getViewerRelevanceForItem(item: RelevanceInput | null | undefined, deps: RelevanceDeps): Promise<ItemRelevance | null> {
  if (!item) return null;
  try {
    const client = await userClient();
    const claims = await getClaims(client);
    if (!claims) return null;
    const membership = await currentMembership(client, claims.userId);
    if (!membership) return null;
    const profile = await getWorkspaceProfile(client, membership.orgId);
    return relevanceForItem(item as Record<string, unknown>, profile, deps);
  } catch (e) {
    log.warn("[viewer-relevance] lens unavailable for this render:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
