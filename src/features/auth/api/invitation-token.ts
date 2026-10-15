// Ported from old_repo/src/app/api/invitations/[token]/route.ts (lines 11-50)
// Ported from old_repo/src/app/api/invitations/[token]/accept/route.ts (lines 11-45)
// Ported from old_repo/src/app/api/invitations/[token]/decline/route.ts (lines 11-44)
import { acceptInvitation, declineInvitation, inviteToken, lookupInvitation } from "@/core/auth/invitations";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseWith } from "@/core/http/parse";

type Ctx = { params: Promise<{ token: string }> };

/** The three token routes share one guard, one token validator and one rpc-error map (in core/auth/invitations). */
async function withToken(request: Request, params: Ctx["params"]) {
  const token = parseWith(inviteToken, (await params).token, "token");
  const user = await requireUser(request);
  return isRefusal(user) ? user : { user, token };
}

export const GET = route<Ctx>("/api/invitations/[token]", async (request, { params }) => {
  const c = await withToken(request, params);
  return isRefusal(c) ? c : ok(c.user.headers, { invitation: await lookupInvitation(c.user.client, c.token) });
});

export const accept = route<Ctx>("/api/invitations/[token]/accept", async (request, { params }) => {
  const c = await withToken(request, params);
  return isRefusal(c) ? c : ok(c.user.headers, { ok: true, org_id: await acceptInvitation(c.user.client, c.token) });
});

export const decline = route<Ctx>("/api/invitations/[token]/decline", async (request, { params }) => {
  const c = await withToken(request, params);
  if (isRefusal(c)) return c;
  await declineInvitation(c.user.client, c.token);
  return ok(c.user.headers, { ok: true, status: "declined" });
});
