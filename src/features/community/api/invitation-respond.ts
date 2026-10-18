// Ported from old_repo/src/app/api/community/invitations/[id]/accept/route.ts (lines 10-90)
// Ported from old_repo/src/app/api/community/invitations/[id]/decline/route.ts (lines 8-58)
// Ported from old_repo/src/app/api/community/invitations/[id]/revoke/route.ts (lines 10-86)
// Accept (the invitee only; one transaction through accept_group_invitation, INV-240), decline (the invitee only) and revoke (the inviter or a group admin). Every pre-read surfaces its error; the writes are conditional
// on the invitation still being pending, so a raced second call answers 409 and changes nothing.
import { serviceClient } from "@/core/db/clients";
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { groupRole, idParam, one } from "./_http";

type Ctx = { params: Promise<{ id: string }> };

export const POST_ACCEPT = route("/api/community/invitations/[id]/accept", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const invitationId = await idParam(ctx, "id", "invitation id");
  const { data, error } = await auth.client.rpc("accept_group_invitation", { p_invitation_id: invitationId });
  if (error) throw dbError(error, { forbidden: "You can't accept this invitation", notFound: "Invitation not found" });
  return ok(auth.headers, { ok: true, group_id: data });
});

export const POST_DECLINE = route("/api/community/invitations/[id]/decline", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const invitationId = await idParam(ctx, "id", "invitation id");
  const inv = await one<{ id: string; invitee_user_id: string; status: string }>(auth.client.from("community_group_invitations").select("id, invitee_user_id, status").eq("id", invitationId).maybeSingle(), "invitation");
  if (!inv) throw new HttpError(404, "Invitation not found");
  if (inv.invitee_user_id !== auth.userId) throw new HttpError(403, "Only the person invited can decline this invitation");
  if (inv.status !== "pending") throw new HttpError(409, `This invitation is already ${inv.status}`);
  const { data, error } = await auth.client.from("community_group_invitations").update({ status: "declined" }).eq("id", invitationId).eq("status", "pending").select("id").maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't decline this invitation" });
  if (!data) throw new HttpError(409, "This invitation has already been answered");
  return ok(auth.headers, { ok: true });
});

export const POST_REVOKE = route("/api/community/invitations/[id]/revoke", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const invitationId = await idParam(ctx, "id", "invitation id");
  const inv = await one<{ id: string; group_id: string; inviter_user_id: string | null; status: string }>(auth.client.from("community_group_invitations").select("id, group_id, inviter_user_id, status").eq("id", invitationId).maybeSingle(), "invitation");
  if (!inv) throw new HttpError(404, "Invitation not found");
  if (inv.status !== "pending") throw new HttpError(409, `This invitation is already ${inv.status}`);
  const isInviter = inv.inviter_user_id === auth.userId;
  if (!isInviter && (await groupRole(auth.client, inv.group_id, auth.userId)) !== "admin") throw new HttpError(403, "Only the person who invited, or a group admin, can withdraw this invitation");
  // No row policy lets an inviter who is no longer an admin write the row, so the write is the service client's, authorised by the two checks above and conditional on the row still being pending.
  const { data, error } = await serviceClient().from("community_group_invitations").update({ status: "revoked" }).eq("id", invitationId).eq("status", "pending").select("id").maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(409, "This invitation has already been answered");
  return ok(auth.headers, { ok: true });
});
