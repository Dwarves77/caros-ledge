// Ported from old_repo/src/app/api/detail/relevance/route.ts (lines 42-79)
// GET /api/detail/relevance?itemId=: the per-viewer relevance lens and the binding-banner data for one item. BUILD-PLAN ruling 3: signed-in callers only (requireUser also rate-limits per user); the
// old route answered anonymous readers on an IP limit. Everything runs on the caller's own client (RLS). A failed read is a 503 with Retry-After, never a 200 with nulls: the banner and the badge
// say "did not load" with Retry, and "no obligations decomposed" stays a different answer.
import { currentMembership } from "@/core/auth/membership";
import { itemIdColumn } from "@/core/detail/id-redirect";
import { LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { fetchObligationObjectsForItem, getWorkspaceProfile, relevanceForItem, summariseObligationBinding } from "@/core/workspace";
import { relevanceDeps } from "@/core/workspace/relevance-deps";

const COLUMNS = "id, title, transport_modes, jurisdictions, jurisdiction_iso, topic_tags, operational_scenario_tags, compliance_object_tags";

export const GET = route("/api/detail/relevance", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const headers = { ...auth.headers, "Cache-Control": "private, no-store" };
  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) return ok(headers, { relevance: null, binding: null });
  const { data: item, error } = await auth.client.from("intelligence_items").select(COLUMNS).eq(itemIdColumn(itemId), itemId).eq("provenance_status", "verified").eq("is_archived", false).maybeSingle();
  if (error) throw new LookupError("intelligence_items", error);
  if (!item) return ok(headers, { relevance: null, binding: null });
  const row = item as unknown as Record<string, unknown> & { id: string };
  let objects: Awaited<ReturnType<typeof fetchObligationObjectsForItem>>;
  try {
    objects = await fetchObligationObjectsForItem(auth.client, row.id);
  } catch (e) {
    throw new LookupError("obligation_objects", e);
  }
  const membership = await currentMembership(auth.client, auth.userId);
  const relevance = membership ? relevanceForItem({ ...row, obligation_objects: objects }, await getWorkspaceProfile(auth.client, membership.orgId), relevanceDeps) : null;
  const binding = relevance?.binding ?? summariseObligationBinding(objects, { orgRoles: [], orgSize: { headcount_band: null, revenue_band: null, shipment_volume_band: null } }, relevanceDeps);
  return ok(headers, { relevance, binding });
});
