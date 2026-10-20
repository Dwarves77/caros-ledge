// Ported from old_repo/src/app/api/orgs/[org_id]/route.ts (lines 24-223)
import { currentMembership } from "@/core/auth/membership";
import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import { renameBody } from "@/core/auth/orgs";
import { serviceClient } from "@/core/db/clients";
import { exactCount } from "@/core/db/query";
import { dbError, HttpError, LookupError, ok, refuse, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson, parseWith, uuid } from "@/core/http/parse";

type Ctx = { params: Promise<{ org_id: string }> };

/** GET /api/orgs/[org_id]: the organisation, its first owner and its member count, for a member or a platform admin (IMP-012: the member list admits the admin, so the record does too). Every read checks its error. */
export const GET = route<Ctx>("/api/orgs/[org_id]", async (request, { params }) => {
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const caller = await currentMembership(auth.client, auth.userId, orgId);
  if (!caller && !(await readOwnPlatformAdmin(auth.client))) return refuse(403, "User has no organization membership");
  const actions = await auth.client.rpc("org_actions", { p_org: orgId });
  if (actions.error) throw new LookupError("org actions", actions.error);
  const service = serviceClient();
  const [org, owner, members] = await Promise.all([
    service.from("organizations").select("id, name, slug, plan, created_at").eq("id", orgId).maybeSingle(),
    service.from("org_memberships").select("user_id, created_at, user:profiles!user_id(full_name, avatar_url)").eq("org_id", orgId).eq("role", "owner").order("created_at", { ascending: true }).limit(1).maybeSingle(),
    exactCount(service.from("org_memberships").select("id", { count: "exact", head: true }).eq("org_id", orgId)).catch((e) => {
      throw new LookupError("member count", e);
    }),
  ]);
  if (org.error) throw new LookupError("organizations", org.error);
  if (owner.error) throw new LookupError("org owner", owner.error);
  if (!org.data) return refuse(404, "org not found");
  const profile = (owner.data?.user ?? null) as { full_name?: string | null } | null;
  return ok(auth.headers, {
    org: org.data,
    caller_role: caller?.role ?? "platform_admin",
    actions: (actions.data ?? []) as string[],
    owner: owner.data ? { user_id: owner.data.user_id, display_name: profile?.full_name ?? "Owner", owner_since: owner.data.created_at } : null,
    member_count: members,
  });
});

/** PATCH /api/orgs/[org_id]: rename or re-slug through rename_org (migration 0101) on the caller's own client: org_can decides (the owner, or a platform admin), a taken slug is a 409, and the event carries both names. */
export const PATCH = route<Ctx>("/api/orgs/[org_id]", async (request, { params }) => {
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const patch = await parseJson(request, renameBody);
  if (patch.name === undefined && patch.slug === undefined) throw new HttpError(400, "Provide at least one of name or slug");
  const { data, error } = await auth.client.rpc("rename_org", { p_org_id: orgId, p_name: patch.name ?? null, p_slug: patch.slug ?? null, p_reason: patch.reason ?? null });
  if (error) throw ["42501", "P0002", "22023", "23505"].includes(error.code ?? "") ? dbError(error, { forbidden: "Only an owner can rename the organization", own: true }) : new LookupError("rename_org", error);
  return ok(auth.headers, { org: data });
});
