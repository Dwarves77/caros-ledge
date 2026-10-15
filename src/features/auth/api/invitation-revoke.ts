// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/[id]/route.ts (lines 11-61)
import { revokeInvitation } from "@/core/auth/invitations";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseWith, uuid } from "@/core/http/parse";

/** DELETE: revoke a pending invitation, scoped to the URL's org before the write (INV-155). */
export const DELETE = route<{ params: Promise<{ org_id: string; id: string }> }>("/api/orgs/[org_id]/invitations/[id]", async (request, { params }) => {
  const { org_id, id } = await params;
  const orgId = parseWith(uuid, org_id, "org_id");
  const invitationId = parseWith(uuid, id, "id");
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  await revokeInvitation(user.client, orgId, invitationId);
  return ok(user.headers, { ok: true, status: "revoked" });
});
