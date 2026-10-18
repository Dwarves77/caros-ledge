// Ported from old_repo/src/app/api/community/groups/[id]/join/route.ts (lines 7-97)
// POST /api/community/groups/[id]/join: self-join a PUBLIC group (INV-240). A private group is entered only by invitation. A banned user is refused by the ban guard on the membership insert (42501 -> 403), the second
// wall behind this route. The pending invitation for the group is cleared with its error read, and the call is idempotent, so a retry after a failed clear converges.
import { serviceClient } from "@/core/db/clients";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";


import { idParam, one, visibleGroup } from "./_http";

export const POST = route("/api/community/groups/[id]/join", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const group = await visibleGroup<{ id: string; privacy: string }>(auth.client, groupId, "id, privacy");
  if (group.privacy !== "public") throw new HttpError(403, "This group is by invitation only");
  const existing = await one<{ group_id: string }>(auth.client.from("community_group_members").select("group_id").eq("group_id", groupId).eq("user_id", auth.userId).maybeSingle(), "membership");
  const service = serviceClient();
  let state: "joined" | "already-member" = "already-member";
  if (!existing) {
    const { error } = await service.from("community_group_members").insert({ group_id: groupId, user_id: auth.userId, role: "member" });
    if (error && error.code === "42501") throw new HttpError(403, "You can't join this group");
    if (error && error.code !== "23505") throw new LookupError("join", error);
    state = error ? "already-member" : "joined";
  }
  const { error: clearError } = await service.from("community_group_invitations").update({ status: "accepted" }).eq("group_id", groupId).eq("invitee_user_id", auth.userId).eq("status", "pending");
  if (clearError) throw new LookupError("pending invitation", clearError);
  return ok(auth.headers, { ok: true, state });
});
