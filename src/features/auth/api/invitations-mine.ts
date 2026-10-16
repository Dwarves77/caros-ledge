// Ported from old_repo/src/app/api/invitations/mine/route.ts (lines 7-63)
// Ported from old_repo/src/app/api/invitations/[token]/accept/route.ts (lines 24-39)
// Ported from old_repo/src/app/api/invitations/[token]/decline/route.ts (lines 24-38)
import { acceptInvitationById, declineInvitationById, pendingInvitationsFor } from "@/core/auth/invitations";
import { serviceClient } from "@/core/db/clients";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseWith, uuid } from "@/core/http/parse";

/** GET: my pending, unexpired invitations by account email. Each carries token_last4 only: the raw token is not stored (migration 0018), the in-app Accept and Decline below act on the row id; the emailed link keeps the raw token. */
export const GET = route("/api/invitations/mine", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  return ok(user.headers, { invitations: await pendingInvitationsFor(serviceClient(), user.userId) });
});

type IdCtx = { params: Promise<{ id: string }> };

/** The in-app Accept and Decline act on the row id: the list carries token_last4 only. The email match, the ban and the expiry live in the rpc (migration 0028). */
async function withId(request: Request, params: IdCtx["params"]) {
  const id = parseWith(uuid, (await params).id, "invitation id");
  const user = await requireUser(request);
  return isRefusal(user) ? user : { user, id };
}

export const accept = route<IdCtx>("/api/invitations/mine/[id]/accept", async (request, { params }) => {
  const c = await withId(request, params);
  return isRefusal(c) ? c : ok(c.user.headers, { ok: true, org_id: await acceptInvitationById(c.user.client, c.id) });
});

export const decline = route<IdCtx>("/api/invitations/mine/[id]/decline", async (request, { params }) => {
  const c = await withId(request, params);
  if (isRefusal(c)) return c;
  await declineInvitationById(c.user.client, c.id);
  return ok(c.user.headers, { ok: true, status: "declined" });
});
