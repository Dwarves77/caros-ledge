// Ported from old_repo/src/app/api/community/groups/[id]/settings/route.ts (lines 8-132)
// PATCH /api/community/groups/[id]/settings: rename, describe, or change the privacy of a group (a group admin, the one canEditGroup rule). A privacy change is never a table write: set_group_privacy (migration 0103)
// narrows for an admin and WIDENS for the owner alone, with a reason and an admin_events row. The pre-reads surface their errors (a database failure is a 503, not a 404 "Group not found"), and an update the row policy
// refuses is a 403, never an ok with no group.
import { z } from "zod";

import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { LIMITS } from "../lib/labels";
import { canEditGroup } from "../lib/group-access";

import { groupRole, idParam, visibleGroup } from "./_http";

const body = z.object({
  name: z.string().trim().min(1, "A group name can't be empty").max(LIMITS.groupName, `A group name is at most ${LIMITS.groupName} characters`).optional(),
  description: z.string().max(LIMITS.groupDescription, `A description is at most ${LIMITS.groupDescription} characters`).nullable().optional(),
  privacy: z.enum(["public", "private"]).optional(),
  privacy_reason: z.string().trim().max(2000).nullish(),
});

export const PATCH = route("/api/community/groups/[id]/settings", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const input = await parseJson(request, body);
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description === null || input.description.trim() === "" ? null : input.description.trim();
  if (Object.keys(update).length === 0 && input.privacy === undefined) throw new HttpError(400, "There is nothing to change");
  const group = await visibleGroup<{ id: string; privacy: "public" | "private" }>(auth.client, groupId, "id, privacy");
  if (!canEditGroup(await groupRole(auth.client, groupId, auth.userId))) throw new HttpError(403, "Only group admins can change a group's settings");
  if (input.privacy !== undefined && input.privacy !== group.privacy) {
    const { error } = await auth.client.rpc("set_group_privacy", { p_group_id: groupId, p_privacy: input.privacy, p_reason: input.privacy_reason || null });
    if (error) throw ["42501", "22023", "P0002"].includes(error.code ?? "") ? dbError(error, { own: true }) : new LookupError("set_group_privacy", error);
  }
  const { data, error } = Object.keys(update).length ? await auth.client.from("community_groups").update(update).eq("id", groupId).select("id, name, slug, region, privacy, description").maybeSingle() : await auth.client.from("community_groups").select("id, name, slug, region, privacy, description").eq("id", groupId).maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't change this group's settings" });
  if (!data) throw new HttpError(403, "You can't change this group's settings");
  return ok(auth.headers, { ok: true, group: data });
});
