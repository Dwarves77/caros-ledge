// Ported from old_repo/src/app/api/community/groups/[id]/members/route.ts (lines 15-150)
// GET the roster (row policy: a member sees themself, an admin or moderator sees everyone) and DELETE to leave. The last-admin rule is the database's (community_group_keeps_an_admin, 22023 -> 409), so no writer can
// route around it. The roster carries no user id: names come from the identity definer, and a member whose identity cannot be read is shown without a name.
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { readRoster } from "../lib/roster";

import { idParam } from "./_http";

const ROSTER_LIMIT = 200;

export const GET = route("/api/community/groups/[id]/members", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const { members, truncated, identityFailed } = await readRoster(auth.client, groupId, auth.userId, ROSTER_LIMIT);
  return ok(auth.headers, { members, truncated, identity_failed: identityFailed });
});

export const DELETE = route("/api/community/groups/[id]/members", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const { data, error } = await auth.client.from("community_group_members").delete().eq("group_id", groupId).eq("user_id", auth.userId).select("user_id");
  if (error) throw dbError(error, { forbidden: "You can't leave this group" });
  if (!data || data.length === 0) throw new HttpError(404, "You are not a member of this group");
  return ok(auth.headers, { ok: true });
});
