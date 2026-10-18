// Ported from old_repo/src/app/api/community/groups/[id]/settings/route.ts (lines 8-132)
// PATCH /api/community/groups/[id]/settings: rename, describe, or change the privacy of a group (its owner, an admin or a moderator). The two pre-reads surface their errors (a database failure is a 503, not a 404
// "Group not found"), and an update the row policy refuses is a 403, never an ok with no group.
import { z } from "zod";

import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { LIMITS } from "../lib/labels";

import { groupRole, idParam, isReviewerRole, visibleGroup } from "./_http";

const body = z.object({
  name: z.string().trim().min(1, "A group name can't be empty").max(LIMITS.groupName, `A group name is at most ${LIMITS.groupName} characters`).optional(),
  description: z.string().max(LIMITS.groupDescription, `A description is at most ${LIMITS.groupDescription} characters`).nullable().optional(),
  privacy: z.enum(["public", "private"]).optional(),
});

export const PATCH = route("/api/community/groups/[id]/settings", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const input = await parseJson(request, body);
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description === null || input.description.trim() === "" ? null : input.description.trim();
  if (input.privacy !== undefined) update.privacy = input.privacy;
  if (Object.keys(update).length === 0) throw new HttpError(400, "There is nothing to change");
  const group = await visibleGroup<{ id: string; owner_user_id: string | null }>(auth.client, groupId, "id, owner_user_id");
  const role = await groupRole(auth.client, groupId, auth.userId);
  if (group.owner_user_id !== auth.userId && !isReviewerRole(role)) throw new HttpError(403, "Only group admins, moderators or the owner can change a group's settings");
  const { data, error } = await auth.client.from("community_groups").update(update).eq("id", groupId).select("id, name, slug, region, privacy, description").maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't change this group's settings" });
  if (!data) throw new HttpError(403, "You can't change this group's settings");
  return ok(auth.headers, { ok: true, group: data });
});
