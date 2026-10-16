// Ported from old_repo/src/app/api/workspace/overrides/route.ts (lines 36-304)
import { z } from "zod";

import { serviceClient, type Db } from "@/core/db/clients";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { isUuid, parseJson } from "@/core/http/parse";
import { log } from "@/core/shared/log";
import { orgWatchersOf } from "@/core/workspace/roster";

import { workspaceDeps } from "./deps";
import { itemUuidOr404 } from "./shared";

// POST   { itemId, priorityOverride?, isArchived?, archiveReason?, archiveNote?, dismissedAt? | dismiss?, ownerUserId? }
//        upserts (org_id, item_id) into workspace_item_overrides. A WORKSPACE archive is the team-wide hide, so it is gated:
//        owner or admin only, a reason required, archived_by stamped from the session (INV-165, INV-166). Restore is ungated.
// DELETE { itemId } removes the row.
// Attribution (archived_by, owner_assigned_by) is built from the session; a body carrying those names is ignored.
const body = z.looseObject({
  itemId: z.string().min(1),
  priorityOverride: z.string().nullable().optional(),
  isArchived: z.boolean().optional(),
  archiveReason: z.string().nullable().optional(),
  archiveNote: z.string().nullable().optional(),
  dismissedAt: z.string().nullable().optional(),
  dismiss: z.boolean().optional(),
  ownerUserId: z.string().nullable().optional(),
});
const deleteBody = z.object({ itemId: z.string().min(1) });

/** The owner must hold a membership in the CALLER'S org and be able to write there (INV-167); an unverifiable lookup is a 503. */
async function assertOwnerInOrg(service: Db, orgId: string, ownerUserId: string): Promise<void> {
  if (!isUuid(ownerUserId)) throw new HttpError(400, "ownerUserId must be a UUID or null");
  const { data, error } = await service.from("org_memberships").select("role").eq("org_id", orgId).eq("user_id", ownerUserId).maybeSingle();
  if (error) throw new LookupError("org_memberships owner", error);
  if (!data) throw new HttpError(403, "Assignee is not a member of your organization");
  if (data.role === "viewer") throw new HttpError(403, "A viewer can read this workspace but cannot own an item");
}

/** Tell the item's org-scoped watchers and its owner about a team archive. The archive has already succeeded, so a failure here is reported in the response, never thrown. */
async function notifyArchive(service: Db, orgId: string, archiverId: string, itemKey: string, itemUuid: string, reason: string, ownerId: string | null) {
  const notify = workspaceDeps().notify;
  try {
    const { data: item, error } = await service.from("intelligence_items").select("title, legacy_id, item_type, domain").eq("id", itemUuid).maybeSingle();
    if (error) throw new LookupError("intelligence_items", error);
    const { watcherIds } = await orgWatchersOf(service, orgId, [itemKey, itemUuid, item?.legacy_id ?? ""]);
    const recipients = new Set(watcherIds);
    if (ownerId) recipients.add(ownerId);
    recipients.delete(archiverId);
    if (recipients.size === 0) return { sent: 0, failed: 0, error: null };
    if (!notify) return { sent: 0, failed: recipients.size, error: "notification dispatch is not wired" };
    const uiId = item?.legacy_id || itemUuid;
    const link = workspaceDeps().itemHref?.({ id: uiId, type: item?.item_type ?? null, domain: item?.domain ?? null }) ?? `/regulations/${encodeURIComponent(uiId)}`;
    let sent = 0;
    let failed = 0;
    for (const userId of recipients) {
      const err = await notify({
        userId,
        kind: "archive",
        payload: {
          title: "Item archived for the workspace",
          body: `"${item?.title || "an item"}" was archived for your whole workspace${reason ? `, reason: ${reason}` : ""}. Any member can restore it from Settings, Archive.`,
          link,
          item_id: itemUuid,
          archived_by: archiverId,
        },
      });
      if (err) {
        failed += 1;
        log.warn("[overrides] archive notification failed:", err);
      } else sent += 1;
    }
    return { sent, failed, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("[overrides] archive notification fan-out failed:", message);
    return { sent: 0, failed: 0, error: message };
  }
}

export const POST = route("/api/workspace/overrides", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const { orgId, role } = auth.membership;
  const input = await parseJson(request, body);
  const service = serviceClient();
  const itemUuid = await itemUuidOr404(service, input.itemId);
  if ("notes" in input) throw new HttpError(400, "Workspace notes moved. Use /api/workspace/items/{id}/notes to add, edit or delete a note.");

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { org_id: orgId, item_id: itemUuid, updated_at: now };
  if (input.priorityOverride !== undefined) update.priority_override = input.priorityOverride;
  if (input.isArchived !== undefined) {
    update.is_archived = input.isArchived;
    update.archived_at = input.isArchived ? now : null;
  }
  if (input.archiveReason !== undefined) update.archive_reason = input.archiveReason;
  if (input.archiveNote !== undefined) update.archive_note = input.archiveNote;
  if (input.isArchived === true) {
    if (!(input.archiveReason ?? "").trim()) throw new HttpError(400, "archiveReason is required to archive for the workspace");
    if (role !== "owner" && role !== "admin") throw new HttpError(403, "Workspace archive requires the admin or owner role. You can archive it just for yourself instead.");
    update.archived_by = auth.userId;
  } else if (input.isArchived === false) update.archived_by = null;
  if (input.dismissedAt !== undefined) update.dismissed_at = input.dismissedAt;
  else if (input.dismiss !== undefined) update.dismissed_at = input.dismiss ? now : null;
  if (input.ownerUserId !== undefined) {
    const ownerUserId = input.ownerUserId || null;
    if (ownerUserId) await assertOwnerInOrg(service, orgId, ownerUserId);
    update.owner_user_id = ownerUserId;
    update.owner_assigned_by = ownerUserId ? auth.userId : null;
    update.owner_assigned_at = ownerUserId ? now : null;
  }

  const { data, error } = await service.from("workspace_item_overrides").upsert(update, { onConflict: "org_id,item_id" }).select().single();
  if (error) throw dbError(error);
  const notifications = input.isArchived === true ? await notifyArchive(service, orgId, auth.userId, input.itemId, itemUuid, input.archiveReason ?? "", (data as { owner_user_id?: string | null } | null)?.owner_user_id ?? null) : null;
  workspaceDeps().revalidateWorkspaceData?.();
  return ok(auth.headers, { override: data, ...(notifications ? { notifications } : {}) });
});

export const DELETE = route("/api/workspace/overrides", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, deleteBody);
  const service = serviceClient();
  const itemUuid = await itemUuidOr404(service, input.itemId);
  const { error } = await service.from("workspace_item_overrides").delete().eq("org_id", auth.membership.orgId).eq("item_id", itemUuid);
  if (error) throw dbError(error);
  workspaceDeps().revalidateWorkspaceData?.();
  return ok(auth.headers, { success: true });
});
