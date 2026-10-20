// Ported from old_repo/src/app/api/orgs/[org_id]/members/route.ts (lines 10-619)
// The members of an organisation. Every write is ONE database function on the CALLER'S client (set_member_role, remove_member, ban_member, invite_member: migrations 0101): the actor is the session, who may is org_can (one
// decision, in the database), the SEC-3b rules and the admin_events row are in the same transaction. This route decides nothing about roles: a refusal is the function's, mapped through the one status table, and the service client
// is not used here. The roster comes from org_roster, which gives an e-mail only to an owner or admin of this organisation and never falls back to one as a name.
import { z } from "zod";

import { createInvitation } from "@/core/auth/invitations";
import { currentMembership } from "@/core/auth/membership";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser, type UserContext } from "@/core/http/guard";
import { email, parseJson, parseWith, uuid } from "@/core/http/parse";

type Ctx = { params: Promise<{ org_id: string }> };

const ROSTER_BOUND = 200;
const reason = z.string().trim().max(2000).nullish();
const patchBody = z.object({ membership_id: uuid, role: z.enum(["owner", "admin", "member", "viewer"]), reason });
const banBody = z.object({ membership_id: uuid, reason });
const addBody = z.object({ email, role: z.enum(["admin", "member", "viewer"]).default("member") });
type RosterRow = { id: string; user_id: string; role: string; joined_at: string; display_name: string | null; avatar_url: string | null; email: string | null };

/** The caller and the URL's organisation. */
async function load(request: Request, params: Ctx["params"]): Promise<Response | { user: UserContext; orgId: string }> {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  return { user, orgId: parseWith(uuid, (await params).org_id, "org_id") };
}

/** The function's own refusals (not allowed, not found, a rule it keeps) carry sentences written for the customer; anything else is a failed write the customer is told to retry, with the driver text in the log. */
const OWN_REFUSALS = new Set(["42501", "P0002", "22023"]);

/** A member-changing function's answer: the row on success, else its refusal through the one status table. The call itself is written at the call site as `user.client.rpc("name", args)`, where the static column check reads its name and arguments. */
function done(res: { data: unknown; error: { code?: string | null; message: string } | null }, name: string): unknown {
  if (res.error) throw OWN_REFUSALS.has(res.error.code ?? "") ? dbError(res.error, { own: true }) : new LookupError(name, res.error);
  return res.data;
}

/** GET: the member list (bounded; `truncated` says when the bound was hit) and what the caller may do here, for a member or a platform admin. E-mail addresses reach owners and admins of this organisation only. */
export const GET = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params);
  if (isRefusal(ctx)) return ctx;
  const { user, orgId } = ctx;
  const [roster, actions, caller] = await Promise.all([user.client.rpc("org_roster", { p_org_id: orgId, p_limit: ROSTER_BOUND }), user.client.rpc("org_actions", { p_org: orgId }), currentMembership(user.client, user.userId, orgId)]);
  if (roster.error?.code === "42501") throw new HttpError(403, "Not a member of this organization");
  if (roster.error) throw new LookupError("org roster", roster.error);
  if (actions.error) throw new LookupError("org actions", actions.error);
  const rows = (roster.data ?? []) as RosterRow[];
  return ok(user.headers, {
    members: rows.slice(0, ROSTER_BOUND).map((r) => ({ id: r.id, user_id: r.user_id, role: r.role, joined_at: r.joined_at, display_name: r.display_name ?? "Member", avatar_url: r.avatar_url, ...(r.email ? { email: r.email } : {}) })),
    truncated: rows.length > ROSTER_BOUND,
    caller_role: caller?.role ?? "platform_admin",
    actions: (actions.data ?? []) as string[],
  });
});

/** PATCH: change a role. The body names a membership, a role and optionally a reason, nothing else. Demoting the only owner is a 409 (INV-153). */
export const PATCH = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params);
  if (isRefusal(ctx)) return ctx;
  const body = await parseJson(request, patchBody);
  return ok(ctx.user.headers, { membership: done(await ctx.user.client.rpc("set_member_role", { p_org_id: ctx.orgId, p_membership_id: body.membership_id, p_role: body.role, p_reason: body.reason ?? null }), "set_member_role") });
});

/** POST: ban a member from this organisation (an org-scoped ban): the ban row, the removal and the event are one transaction. */
export const POST = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params);
  if (isRefusal(ctx)) return ctx;
  const body = await parseJson(request, banBody);
  done(await ctx.user.client.rpc("ban_member", { p_org_id: ctx.orgId, p_membership_id: body.membership_id, p_reason: body.reason ?? null }), "ban_member");
  return ok(ctx.user.headers, { success: true, membership_id: body.membership_id });
});

/** DELETE ?membership_id=: remove a member. Nobody removes themselves here, and the only owner stays. */
export const DELETE = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params);
  if (isRefusal(ctx)) return ctx;
  const membershipId = parseWith(uuid, new URL(request.url).searchParams.get("membership_id"), "membership_id");
  done(await ctx.user.client.rpc("remove_member", { p_org_id: ctx.orgId, p_membership_id: membershipId, p_reason: null }), "remove_member");
  return ok(ctx.user.headers, { success: true, membership_id: membershipId });
});

/**
 * PUT: add a person by e-mail. This is an INVITATION the person accepts, never a join: no account is added without its owner's consent, and the answer is the same 202 whether or not the address has an account (the
 * database function never reads accounts), so the route is no oracle for who is registered. A registered invitee finds it in their account's pending invitations; the link comes from POST /invitations.
 */
export const PUT = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params);
  if (isRefusal(ctx)) return ctx;
  const body = await parseJson(request, addBody);
  await createInvitation(ctx.user.client, { orgId: ctx.orgId, userId: ctx.user.userId, email: body.email, role: body.role, baseUrl: process.env.NEXT_PUBLIC_APP_URL || request.headers.get("origin") || "" });
  return ok(ctx.user.headers, { status: "invited" }, 202);
});
