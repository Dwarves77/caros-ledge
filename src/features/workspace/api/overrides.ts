// Ported from old_repo/src/app/api/workspace/overrides/route.ts (lines 36-304)
import { z } from "zod";

import { admitItems } from "@/core/derived/admissible";
import { isMissingObject } from "@/core/db/absent";
import type { Db } from "@/core/db/clients";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { isUuid, parseJson } from "@/core/http/parse";

import { workspaceDeps } from "./deps";
import { itemUuidOr404 } from "./shared";

// POST   { itemId, priorityOverride?, isArchived?, archiveReason?, archiveNote?, dismissedAt? | dismiss?, ownerUserId?, reason? }
//        The table takes no client write (migration 0121): every change is ONE database function on the caller's client, which decides who may and writes in one transaction.
//        priorityOverride (including null, the platform default) is set_priority_override and isArchived:false is restore_team_item: owner or admin acts that carry a required `reason` (1 to 2000 characters), written with the
//        act to admin_events (migration 0101). A WORKSPACE archive is the team-wide hide, so it is gated the same way: owner or admin only, a reason required, archived_by stamped from the session (INV-165, INV-166), and it and an
//        assignment run as one database call each with their notices queued in the same transaction (0037). dismissedAt or dismiss is set_item_dismissal (0121): a member's act, dismissed_at only.
// Attribution (archived_by, owner_assigned_by) is built from the session; a body carrying those names is ignored. There is no DELETE: the row is never removed by a client.
const reasonText = z.string().trim().min(1).max(2000);
const body = z.looseObject({
  itemId: z.string().min(1),
  priorityOverride: z.string().nullable().optional(),
  isArchived: z.boolean().optional(),
  archiveReason: z.string().nullable().optional(),
  archiveNote: z.string().nullable().optional(),
  dismissedAt: z.string().nullable().optional(),
  dismiss: z.boolean().optional(),
  ownerUserId: z.string().nullable().optional(),
  reason: reasonText.optional(),
});

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
  const { data: item, error } = await admitItems(db.from("intelligence_items").select("title, legacy_id, item_type, domain").eq("id", itemUuid)).maybeSingle();
  if (error) throw new LookupError("intelligence_items", error);
  const uiId = item?.legacy_id || itemUuid;
  const link = workspaceDeps().itemHref?.({ id: uiId, type: item?.item_type ?? null, domain: item?.domain ?? null }) ?? `/regulations/${encodeURIComponent(uiId)}`;
  return { title, body: text(item?.title || "an item"), link };
}

type Writer = "archive_item_for_team" | "assign_item" | "set_priority_override" | "restore_team_item" | "set_item_dismissal";

/** One of the writers (migrations 0037, 0101, 0121): the override write and, where there is one, its outbox rows or event in ONE transaction. An absent function (42883 / PGRST202: production before the cutover) is a 503 with Retry, never a second way to write; the function's own refusals (not allowed, no such row) carry its sentence. */
async function callWriter(db: Db, name: Writer, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (isMissingObject(error)) throw new HttpError(503, "This change cannot be saved until the database update that supports it is applied. Try again shortly.", { "Retry-After": "30" });
  if (error) throw dbError(error, { own: true });
  return data;
}

type Written = { override: unknown; queued: number };

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
  // A workspace-wide change of urgency or visibility says why; the sentence is written with the act (set_priority_override, restore_team_item).
  const prioritising = input.priorityOverride !== undefined;
  const restoring = input.isArchived === false;
  if ((prioritising || restoring) && input.reason === undefined) throw new HttpError(400, "reason is required (1 to 2000 characters) to change the priority or restore an archived item for the workspace");
  const dismissal = input.dismissedAt !== undefined ? input.dismissedAt !== null : input.dismiss;
  const ownerUserId = input.ownerUserId || null;
  if (input.ownerUserId !== undefined && ownerUserId) await assertOwnerInOrg(db, orgId, ownerUserId);
  if (!archiving && !restoring && (input.archiveReason !== undefined || input.archiveNote !== undefined)) throw new HttpError(400, "archiveReason and archiveNote belong to an archive: name isArchived: true with them.");
  if (!prioritising && !restoring && !archiving && dismissal === undefined && input.ownerUserId === undefined) throw new HttpError(400, "Nothing to change: name a priority, an archive, a restore, a dismissal or an owner.");

  let override: unknown = null;
  let queued: number | null = null;
  if (prioritising) override = await callWriter(db, "set_priority_override", { p_org_id: orgId, p_item_id: itemUuid, p_priority: input.priorityOverride, p_reason: input.reason });
  if (restoring) override = await callWriter(db, "restore_team_item", { p_org_id: orgId, p_item_id: itemUuid, p_reason: input.reason });
  if (dismissal !== undefined) override = await callWriter(db, "set_item_dismissal", { p_org_id: orgId, p_item_id: itemUuid, p_dismissed: dismissal });
  if (input.ownerUserId !== undefined) {
    const notice = ownerUserId ? await noticeOf(db, itemUuid, "Item assigned to you", (name) => `"${name}" was assigned to you as its owner.`) : null;
    const r = (await callWriter(db, "assign_item", { p_org_id: orgId, p_item_id: itemUuid, p_owner_user_id: ownerUserId, p_notice: notice })) as Written;
    [override, queued] = [r.override, r.queued];
  }
  if (archiving) {
    const reason = input.archiveReason ?? "";
    const notice = await noticeOf(db, itemUuid, "Item archived for the workspace", (name) => `"${name}" was archived for your whole workspace${reason ? `, reason: ${reason}` : ""}. An owner or admin can restore it from Settings, Archive.`);
    const r = (await callWriter(db, "archive_item_for_team", { p_org_id: orgId, p_item_id: itemUuid, p_reason: reason, p_note: input.archiveNote ?? null, p_notice: notice })) as Written;
    [override, queued] = [r.override, (queued ?? 0) + r.queued];
  }
  return ok(auth.headers, { override, ...(queued === null ? {} : { queued }) });
});
