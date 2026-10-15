// Ported from old_repo/src/app/api/invitations/mine/route.ts (lines 7-63)
import { pendingInvitationsFor } from "@/core/auth/invitations";
import { serviceClient } from "@/core/db/clients";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

/** GET: my pending, unexpired invitations by account email. Each carries its raw token: the invitee needs it to accept. */
export const GET = route("/api/invitations/mine", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  return ok(user.headers, { invitations: await pendingInvitationsFor(serviceClient(), user.userId) });
});
