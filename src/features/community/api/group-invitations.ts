// Ported from old_repo/src/app/api/community/groups/[id]/invitations/route.ts (lines 17-94)
// Ported from old_repo/src/app/api/community/groups/[id]/invite-candidates/route.ts (lines 12-92)
// Ported from old_repo/src/app/api/community/groups/[id]/invite/route.ts (lines 9-128)
// A group's invitations: list the pending ones (admin or moderator), search invite candidates (admin), invite (admin). Every pre-read surfaces its error; a failed exclusion read is a 503, so it can never offer an
// existing member as a candidate. The invitee is notified through the outbox; a failed queue never undoes the invitation.
import { z } from "zod";

import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { queueNotifications } from "@/core/notifications";
import { log } from "@/core/shared/log";

import { loadIdentities } from "../lib/identity";

import { groupRole, idField, idParam, isReviewerRole, many, one, visibleGroup } from "./_http";

const MAX_CANDIDATES = 12;
const MIN_QUERY = 2;
type Ctx = { params: Promise<{ id: string }> };

export const GET_INVITATIONS = route("/api/community/groups/[id]/invitations", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const role = await groupRole(auth.client, groupId, auth.userId);
  if (!isReviewerRole(role)) throw new HttpError(403, "Only group admins or moderators can see invitations");
  const rows = await many<{ id: string; invitee_user_id: string; inviter_user_id: string | null; created_at: string }>(
    auth.client.from("community_group_invitations").select("id, invitee_user_id, inviter_user_id, created_at").eq("group_id", groupId).eq("status", "pending").order("created_at", { ascending: false }).order("id", { ascending: true }).limit(200),
    "invitations",
  );
  const { byId, error } = await loadIdentities(auth.client, rows.map((r) => r.invitee_user_id));
  const invitations = rows.map((r) => {
    const identity = byId.get(r.invitee_user_id);
    const hidden = !identity || identity.anonymous;
    return { id: r.id, created_at: r.created_at, invitee_name: hidden ? null : identity.display_name, invitee_avatar: hidden ? null : identity.avatar_url, can_revoke: r.inviter_user_id === auth.userId || role === "admin" };
  });
  return ok(auth.headers, { invitations, identity_failed: error !== null });
});

export const GET_CANDIDATES = route("/api/community/groups/[id]/invite-candidates", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  if ((await groupRole(auth.client, groupId, auth.userId)) !== "admin") throw new HttpError(403, "Only group admins can search for people to invite");
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY) return ok(auth.headers, { candidates: [] });
  const [members, pending, bans] = await Promise.all([
    many<{ user_id: string }>(auth.client.from("community_group_members").select("user_id").eq("group_id", groupId).limit(200), "members"),
    many<{ invitee_user_id: string }>(auth.client.from("community_group_invitations").select("invitee_user_id").eq("group_id", groupId).eq("status", "pending").limit(200), "invitations"),
    many<{ user_id: string }>(auth.client.from("community_group_bans").select("user_id").eq("group_id", groupId).limit(200), "bans"),
  ]);
  const excluded = new Set<string>([auth.userId, ...members.map((m) => m.user_id), ...pending.map((p) => p.invitee_user_id), ...bans.map((b) => b.user_id)]);
  const { rows, error } = await loadIdentities(auth.client, null, q);
  if (error) throw new HttpError(503, "People search is unavailable just now", { "Retry-After": "1" });
  const candidates = rows
    .filter((p) => p.display_name && !excluded.has(p.user_id))
    .slice(0, MAX_CANDIDATES)
    .map((p) => ({ user_id: p.user_id, name: p.display_name, headshot_url: p.avatar_url }));
  return ok(auth.headers, { candidates });
});

export const POST_INVITE = route("/api/community/groups/[id]/invite", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const groupId = await idParam(ctx, "id", "group id");
  const { invitee_user_id: inviteeId } = await parseJson(request, z.object({ invitee_user_id: idField("person") }));
  if (inviteeId === auth.userId) throw new HttpError(400, "You can't invite yourself");
  if ((await groupRole(auth.client, groupId, auth.userId)) !== "admin") throw new HttpError(403, "Only group admins can send invitations");
  const group = await visibleGroup<{ id: string; name: string }>(auth.client, groupId, "id, name");
  const [already, banned] = await Promise.all([
    one<{ user_id: string }>(auth.client.from("community_group_members").select("user_id").eq("group_id", groupId).eq("user_id", inviteeId).maybeSingle(), "membership"),
    one<{ user_id: string }>(auth.client.from("community_group_bans").select("user_id").eq("group_id", groupId).eq("user_id", inviteeId).maybeSingle(), "ban"),
  ]);
  if (already) throw new HttpError(409, "That person is already in this group");
  if (banned) throw new HttpError(409, "That person is banned from this group");
  const { data, error } = await auth.client.from("community_group_invitations").insert({ group_id: groupId, inviter_user_id: auth.userId, invitee_user_id: inviteeId, status: "pending" }).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "An invitation is already pending for that person");
    if (error.code === "23503") throw new HttpError(404, "That person was not found");
    throw dbError(error, { forbidden: "Only group admins can send invitations" });
  }
  if (!data) throw new HttpError(403, "Only group admins can send invitations");
  const queued = await queueNotifications([{ userId: inviteeId, kind: "invite", payload: { title: `Invitation to ${group.name}`, body: "A group admin invited you to join. Open Community to accept or decline.", link: "/community", group_id: groupId, invitation_id: data.id } }]);
  if (queued) log.warn("[community] the invitation was saved but its notification was not queued:", queued);
  return ok(auth.headers, { ok: true, invitation_id: data.id, notified: queued === null });
});
