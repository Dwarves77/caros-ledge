// Ported from old_repo/src/app/api/workspace/archive-impact/route.ts (lines 30-204)
import { currentMembership } from "@/core/auth/membership";
import { serviceClient } from "@/core/db/clients";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { isUuid } from "@/core/http/parse";
import { displayNameOf, isOrgAdmin, orgWatchersOf } from "@/core/workspace/roster";

const WATCHER_NAME_CAP = 5;

// GET ?itemId=<legacy_id|uuid>: the truthful pre-archive warning (migration 235). It reads live rows (who watches the item, who owns it,
// whether it is CRITICAL) so the dialog never guesses. The role it returns is ADVISORY UI state; the enforcement is the role gate in
// the overrides route. Watchers are scoped to the caller's org by membership (a cross-tenant disclosure was fixed here once).
export const GET = route("/api/workspace/archive-impact", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const itemId = (new URL(request.url).searchParams.get("itemId") ?? "").trim();
  if (!itemId) throw new HttpError(400, "itemId is required");

  // The org is resolved BEFORE any item read (B-0084); a failed membership read is a 503, never "no role".
  const membership = await currentMembership(auth.client, auth.userId);
  const orgId = membership?.orgId ?? null;
  const role = membership?.role ?? null;

  const db = auth.client;
  // Branch on the shape rather than composing an .or() string from caller input (an injection surface); .eq() parameterises.
  const itemQuery = db.from("intelligence_items").select("id, legacy_id, title, priority, effective_priority");
  const { data: item, error: itemError } = await (isUuid(itemId) ? itemQuery.eq("id", itemId) : itemQuery.eq("legacy_id", itemId)).maybeSingle();
  if (itemError) throw new LookupError("intelligence_items", itemError);
  if (!item) throw new HttpError(404, `intelligence_items row not found for itemId=${itemId}`);
  const itemUuid = item.id as string;
  const watchKeys = [itemUuid, ...(item.legacy_id ? [item.legacy_id as string] : [])];

  let watcherIds: string[] = [];
  let onTeamWatchlist = false;
  let ownerUserId: string | null = null;
  let alreadyWorkspaceArchived = false;
  let priority = ((item.effective_priority as string | null) || (item.priority as string | null)) ?? null;
  if (orgId) {
    const watchers = await orgWatchersOf(serviceClient(), orgId, watchKeys);
    watcherIds = watchers.watcherIds.filter((id) => id !== auth.userId);
    onTeamWatchlist = watchers.onTeamWatchlist;
    const { data: override, error } = await db.from("workspace_item_overrides").select("owner_user_id, is_archived, priority_override").eq("org_id", orgId).eq("item_id", itemUuid).maybeSingle();
    if (error) throw new LookupError("workspace_item_overrides", error);
    ownerUserId = (override?.owner_user_id as string | null) ?? null;
    alreadyWorkspaceArchived = !!override?.is_archived;
    if (override?.priority_override) priority = override.priority_override as string;
  }

  const { data: personal, error: personalError } = await db.from("user_item_state").select("is_archived").eq("user_id", auth.userId).eq("item_id", itemUuid).maybeSingle();
  if (personalError) throw new LookupError("user_item_state", personalError);

  // Display names for the capped watcher list and the owner, in one lookup.
  const nameTargets = [...new Set([...watcherIds.slice(0, WATCHER_NAME_CAP), ...(ownerUserId ? [ownerUserId] : [])])];
  const nameById = new Map<string, string>();
  if (nameTargets.length > 0) {
    const { data: profiles, error } = await db.from("profiles").select("id, full_name, display_name").in("id", nameTargets);
    if (error) throw new LookupError("profiles", error);
    for (const p of (profiles ?? []) as { id: string; full_name?: string | null; display_name?: string | null }[]) nameById.set(p.id, displayNameOf(p, p.id));
  }

  return ok(auth.headers, {
    itemId: itemUuid,
    title: (item.title as string | null) ?? null,
    priority,
    isCritical: priority === "CRITICAL",
    role,
    canArchiveWorkspace: isOrgAdmin(role),
    watcherCount: watcherIds.length,
    watcherNames: watcherIds.slice(0, WATCHER_NAME_CAP).map((id) => nameById.get(id) || "A teammate"),
    onTeamWatchlist,
    ownerName: ownerUserId ? nameById.get(ownerUserId) || "A teammate" : null,
    alreadyWorkspaceArchived,
    alreadyPersonallyArchived: !!personal?.is_archived,
  });
});
