// Ported from old_repo/src/app/api/workspace/overrides/route.ts (lines 36-304)
import { z } from "zod";

import { isMissingObject } from "@/core/db/absent";
import type { Db } from "@/core/db/clients";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { isUuid, parseJson } from "@/core/http/parse";

import { workspaceDeps } from "./deps";
import { itemUuidOr404 } from "./shared";

// POST   { itemId, priorityOverride?, isArchived?, archiveReason?, archiveNote?, dismissedAt? | dismiss?, ownerUserId? }
//        writes (org_id, item_id) of workspace_item_overrides. A WORKSPACE archive is the team-wide hide, so it is gated:
//        owner or admin only, a reason required, archived_by stamped from the session (INV-165, INV-166), and it and an assignment run as one database call each with their notices queued in the same transaction (0037). Restore is ungated.
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
async function assertOwnerInOrg(db: Db, orgId: string, ownerUserId: string): Promise<void> {
  if (!isUuid(ownerUserId)) throw new HttpError(400, "ownerUserId must be a UUID or null");
  const { data, error } = await db.from("org_memberships").select("role").eq("org_id", orgId).eq("user_id", ownerUserId).maybeSingle();
  if (error) throw new LookupError("org_memberships owner", error);
  if (!data) throw new HttpError(403, "Assignee is not a member of your organization");
  if (data.role === "viewer") throw new HttpError(403, "A viewer can read this workspace but cannot own an item");
}

/** The text and link of a notice about an item, read on the caller's own client (it is an item they may open). The recipients are the database's to choose, in the same transaction as the write. */
async function noticeOf(db: Db, itemUuid: string, title: string, text: (name: string) => string): Promise<Record<string, string>> {
  const { data: item, error } = await db.from("intelligence_items").select("title, legacy_id, item_type, domain").eq("id", itemUuid).maybeSingle();
  if (error) throw new LookupError("intelligence_items", error);
  const uiId = item?.legacy_id || itemUuid;
  const link = workspaceDeps().itemHref?.({ id: uiId, type: item?.item_type ?? null, domain: item?.domain ?? null }) ?? `/regulations/${encodeURIComponent(uiId)}`;
  return { title, body: text(item?.title || "an item"), link };
}

/** archive_item_for_team / assign_item (migrations 0037): the override write and its outbox rows in ONE transaction. An absent function (42883 / PGRST202: production before the cutover) is a 503 with Retry, never a second way to write. */
async function callWriter(db: Db, name: "archive_item_for_team" | "assign_item", args: Record<string, unknown>): Promise<{ override: unknown; queued: number }> {
  const { data, error } = await db.rpc(name, args);
  if (isMissingObject(error)) throw new HttpError(503, "This change cannot be saved until the database update that supports it is applied. Try again shortly.", { "Retry-After": "30" });
  if (error) throw dbError(error);
  return data as { override: unknown; queued: number };
}

export const POST = route("/api/workspace/overrides", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const { orgId, role } = auth.membership;
  const input = await parseJson(request, body);
  const db = auth.client;
  const itemUuid = await itemUuidOr404(db, input.itemId);
  if ("notes" in input) throw new HttpError(400, "Workspace notes moved. Use /api/workspace/items/{id}/notes to add, edit or delete a note.");

  const archiving = input.isArchived === true;
  if (archiving) {
    if (!(input.archiveReason ?? "").trim()) throw new HttpError(400, "archiveReason is required to archive for the workspace");
    if (role !== "owner" && role !== "admin") throw new HttpError(403, "Workspace archive requires the admin or owner role. You can archive it just for yourself instead.");
  }
  const ownerUserId = input.ownerUserId || null;
  if (input.ownerUserId !== undefined && ownerUserId) await assertOwnerInOrg(db, orgId, ownerUserId);

  // Priority, dismissal and restore stay plain upserts; the archive and the assignment go through the rpcs, which stamp the attribution from the session and notify in the same transaction.
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { org_id: orgId, item_id: itemUuid, updated_at: now };
  if (input.priorityOverride !== undefined) update.priority_override = input.priorityOverride;
  if (input.isArchived === false) Object.assign(update, { is_archived: false, archived_at: null, archived_by: null });
  if (!archiving && input.archiveReason !== undefined) update.archive_reason = input.archiveReason;
  if (!archiving && input.archiveNote !== undefined) update.archive_note = input.archiveNote;
  if (input.dismissedAt !== undefined) update.dismissed_at = input.dismissedAt;
  else if (input.dismiss !== undefined) update.dismissed_at = input.dismiss ? now : null;

  let override: unknown = null;
  let queued: number | null = null;
  if (Object.keys(update).length > 3 || (!archiving && input.ownerUserId === undefined)) {
    const { data, error } = await db.from("workspace_item_overrides").upsert(update, { onConflict: "org_id,item_id" }).select().single();
    if (error) throw dbError(error);
    override = data;
  }
  if (input.ownerUserId !== undefined) {
    const notice = ownerUserId ? await noticeOf(db, itemUuid, "Item assigned to you", (name) => `"${name}" was assigned to you as its owner.`) : null;
    const r = await callWriter(db, "assign_item", { p_org_id: orgId, p_item_id: itemUuid, p_owner_user_id: ownerUserId, p_notice: notice });
    [override, queued] = [r.override, r.queued];
  }
  if (archiving) {
    const reason = input.archiveReason ?? "";
    const notice = await noticeOf(db, itemUuid, "Item archived for the workspace", (name) => `"${name}" was archived for your whole workspace${reason ? `, reason: ${reason}` : ""}. Any member can restore it from Settings, Archive.`);
    const r = await callWriter(db, "archive_item_for_team", { p_org_id: orgId, p_item_id: itemUuid, p_reason: reason, p_note: input.archiveNote ?? null, p_notice: notice });
    [override, queued] = [r.override, (queued ?? 0) + r.queued];
  }
  workspaceDeps().revalidateWorkspaceData?.();
  return ok(auth.headers, { override, ...(queued === null ? {} : { queued }) });
});

export const DELETE = route("/api/workspace/overrides", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, deleteBody);
  const db = auth.client;
  const itemUuid = await itemUuidOr404(db, input.itemId);
  const { error } = await db.from("workspace_item_overrides").delete().eq("org_id", auth.membership.orgId).eq("item_id", itemUuid);
  if (error) throw dbError(error);
  workspaceDeps().revalidateWorkspaceData?.();
  return ok(auth.headers, { success: true });
});
