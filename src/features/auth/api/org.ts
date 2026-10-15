// Ported from old_repo/src/app/api/orgs/[org_id]/route.ts (lines 24-223)
import { updateOrg, renameBody } from "@/core/auth/orgs";
import { serviceClient } from "@/core/db/clients";
import { exactCount } from "@/core/db/query";
import { LookupError, ok, refuse, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { parseJson, parseWith, uuid } from "@/core/http/parse";

type Ctx = { params: Promise<{ org_id: string }> };

/** GET /api/orgs/[org_id]: the organisation, its first owner and its member count, for a member. Every read checks its error. */
export const GET = route<Ctx>("/api/orgs/[org_id]", async (request, { params }) => {
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const auth = await requireOrgRole(request, "viewer", orgId);
  if (isRefusal(auth)) return auth;
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
    caller_role: auth.membership.role,
    owner: owner.data ? { user_id: owner.data.user_id, display_name: profile?.full_name ?? `${String(owner.data.user_id).slice(0, 8)}...`, owner_since: owner.data.created_at } : null,
    member_count: members,
  });
});

/** PATCH /api/orgs/[org_id]: rename or re-slug; owner only. */
export const PATCH = route<Ctx>("/api/orgs/[org_id]", async (request, { params }) => {
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const auth = await requireOrgRole(request, "owner", orgId);
  if (isRefusal(auth)) return auth;
  const patch = await parseJson(request, renameBody);
  return ok(auth.headers, { org: await updateOrg(serviceClient(), orgId, patch) });
});
