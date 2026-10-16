// Ported from old_repo/src/app/api/orgs/[org_id]/members/route.ts (lines 10-619)
import { z } from "zod";

import { assertNotLastOwner, currentMembership, isBanned } from "@/core/auth/membership";
import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import { serviceClient, type Db } from "@/core/db/clients";
import { boundedRead } from "@/core/db/query";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser, type UserContext } from "@/core/http/guard";
import { email, parseJson, parseWith, uuid } from "@/core/http/parse";
import type { OrgMembership } from "@/core/types";

type Ctx = { params: Promise<{ org_id: string }> };
type Target = { id: string; user_id: string; role: string; org_id: string };

const roles = z.enum(["owner", "admin", "member", "viewer"]);
const addRoles = z.enum(["admin", "member", "viewer"]);
const patchBody = z.object({ membership_id: uuid, role: roles });
const banBody = z.object({ membership_id: uuid, reason: z.string().max(2000).nullish() });
const addBody = z.object({ email, role: addRoles.default("member") });

/** The caller, the URL org and their membership. Managing is owner or platform admin (the admin bit is the caller's own, read on their own client); a failed read is a 503, never a 403. */
async function load(request: Request, params: Ctx["params"], need: "member" | "manager"): Promise<Response | { user: UserContext; service: Db; orgId: string; caller: OrgMembership | null }> {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const service = serviceClient();
  const caller = await currentMembership(user.client, user.userId, orgId);
  const admin = caller?.role === "owner" || (await readOwnPlatformAdmin(user.client));
  if (need === "manager" && !admin) throw new HttpError(403, caller ? "Owner role (or platform admin) required for this action" : "Not a member of this organization");
  if (need === "member" && !caller && !admin) throw new HttpError(403, "Not a member of this organization");
  return { user, service, orgId, caller };
}

async function target(service: Db, orgId: string, membershipId: string): Promise<Target> {
  const { data, error } = await service.from("org_memberships").select("id, user_id, role, org_id").eq("id", membershipId).maybeSingle();
  if (error) throw new LookupError("org_memberships target", error);
  if (!data || data.org_id !== orgId) throw new HttpError(404, "membership not found in this org");
  return data as Target;
}

const write = (error: { message: string } | null) => {
  if (error) throw new HttpError(500, error.message);
};

/** GET: the member list (bounded at 200; `truncated` says when the bound was hit), for a member or a platform admin. */
export const GET = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params, "member");
  if (isRefusal(ctx)) return ctx;
  const { user, service, orgId, caller } = ctx;
  const read = await boundedRead(
    (limit) => service.from("org_memberships").select("id, user_id, role, created_at, user:profiles!user_id(full_name, display_name, email, avatar_url)").eq("org_id", orgId).order("created_at", { ascending: true }).limit(limit),
    { limit: 200 },
  );
  if (read.error) throw new LookupError("org members", read.error);
  type Row = { id: string; user_id: string; role: string; created_at: string; user: { full_name?: string | null; display_name?: string | null; email?: string | null; avatar_url?: string | null } | null };
  return ok(user.headers, {
    members: (read.data as unknown as Row[]).map((r) => ({ id: r.id, user_id: r.user_id, role: r.role, joined_at: r.created_at, display_name: r.user?.full_name ?? r.user?.display_name ?? r.user?.email ?? `${String(r.user_id).slice(0, 8)}...`, avatar_url: r.user?.avatar_url ?? null })),
    truncated: read.truncated,
    caller_role: caller?.role ?? "platform_admin",
  });
});

/** PATCH: change a role. The body names a membership and a role and nothing else (a request cannot set any other column). Demoting the only owner is a 409 (INV-153). */
export const PATCH = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params, "manager");
  if (isRefusal(ctx)) return ctx;
  const body = await parseJson(request, patchBody);
  const row = await target(ctx.service, ctx.orgId, body.membership_id);
  if (row.role === "owner" && body.role !== "owner") await assertNotLastOwner(ctx.service, ctx.orgId, "demote");
  const { data, error } = await ctx.service.from("org_memberships").update({ role: body.role }).eq("id", row.id).select("id, role").maybeSingle();
  write(error);
  return ok(ctx.user.headers, { membership: data });
});

/** POST: ban a member from this organisation (an org-scoped ban, not a platform ban). The ban row is written before the membership is removed. */
export const POST = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params, "manager");
  if (isRefusal(ctx)) return ctx;
  const body = await parseJson(request, banBody);
  const row = await target(ctx.service, ctx.orgId, body.membership_id);
  if (row.user_id === ctx.user.userId) throw new HttpError(403, "You cannot ban yourself");
  if (row.role === "owner") await assertNotLastOwner(ctx.service, ctx.orgId, "ban");
  write((await ctx.service.from("org_member_bans").upsert({ org_id: ctx.orgId, user_id: row.user_id, banned_by: ctx.user.userId, reason: body.reason ?? null }, { onConflict: "org_id,user_id" })).error);
  write((await ctx.service.from("org_memberships").delete().eq("id", row.id)).error);
  return ok(ctx.user.headers, { success: true, banned_user_id: row.user_id, membership_id: row.id });
});

/** DELETE ?membership_id=: remove a member. Nobody removes themselves here, and the only owner stays. */
export const DELETE = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params, "manager");
  if (isRefusal(ctx)) return ctx;
  const membershipId = parseWith(uuid, new URL(request.url).searchParams.get("membership_id"), "membership_id");
  const row = await target(ctx.service, ctx.orgId, membershipId);
  if (row.user_id === ctx.user.userId) throw new HttpError(403, "Owners cannot revoke their own membership");
  if (row.role === "owner") await assertNotLastOwner(ctx.service, ctx.orgId, "revoke");
  write((await ctx.service.from("org_memberships").delete().eq("id", row.id)).error);
  return ok(ctx.user.headers, { success: true, membership_id: row.id });
});

/** PUT: add an existing account by email. A banned account is refused; the role cannot be owner. */
export const PUT = route<Ctx>("/api/orgs/[org_id]/members", async (request, { params }) => {
  const ctx = await load(request, params, "manager");
  if (isRefusal(ctx)) return ctx;
  const body = await parseJson(request, addBody);
  const { data: found, error } = await ctx.service.rpc("profiles_by_email", { p_email: body.email });
  if (error) throw new LookupError("profiles by email", error);
  const accounts = (found ?? []) as { id: string }[];
  if (accounts.length > 1) throw new LookupError("profiles by email", new Error("more than one account has this address"));
  const profile = accounts[0];
  if (!profile) throw new HttpError(404, `No account exists for ${body.email}. Provision the user first (Admin, Users) or send an invitation.`);
  if (await isBanned(ctx.service, ctx.orgId, profile.id)) throw new HttpError(403, "This account is banned from this workspace. Clear the ban before re-adding.");
  const existing = await ctx.service.from("org_memberships").select("id").eq("org_id", ctx.orgId).eq("user_id", profile.id).maybeSingle();
  if (existing.error) throw new LookupError("org_memberships existing", existing.error);
  if (existing.data) throw new HttpError(409, "Already a member of this workspace");
  const { data: created, error: insertError } = await ctx.service.from("org_memberships").insert({ org_id: ctx.orgId, user_id: profile.id, role: body.role }).select("id, user_id, role").single();
  write(insertError);
  return ok(ctx.user.headers, { membership: created }, 201);
});
