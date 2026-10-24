// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 14-154)
import { createInvitation, inviteBaseUrl, inviteBody, listInvitations } from "@/core/auth/invitations";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson, parseWith, uuid } from "@/core/http/parse";

type Ctx = { params: Promise<{ org_id: string }> };

/** POST: invite by email with a role (RLS decides who may). The response carries the invite URL and an honest email-delivery result. */
export const POST = route<Ctx>("/api/orgs/[org_id]/invitations", async (request, { params }) => {
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  const body = await parseJson(request, inviteBody);
  const baseUrl = inviteBaseUrl();
  const { invitation, emailDelivery } = await createInvitation(user.client, { orgId, userId: user.userId, email: body.email, role: body.role, baseUrl });
  return ok(user.headers, { invitation, email_delivery: emailDelivery }, 201);
});

/** GET: the org's invitations with lazy expiry. */
export const GET = route<Ctx>("/api/orgs/[org_id]/invitations", async (request, { params }) => {
  const orgId = parseWith(uuid, (await params).org_id, "org_id");
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  return ok(user.headers, { invitations: await listInvitations(user.client, orgId) });
});
