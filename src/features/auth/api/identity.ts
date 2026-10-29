// Ported from old_repo/src/app/api/auth/identity/route.ts (lines 41-69)
import { getClaims } from "@/core/auth/claims";
import { EMPTY_IDENTITY, resolveIdentity } from "@/core/auth/identity";
import { bearerToken, userClient, type Db } from "@/core/db/clients";
import { route } from "@/core/http/errors";
import { checkRateLimit, hostScopedKey } from "@/core/http/rate-limit";
import { captureError } from "@/core/shared/telemetry";
import { loadBootstrapBundle } from "@/features/workspace/api/bootstrap";

const NO_STORE = { "Cache-Control": "private, no-store" };

async function readUnreadCount(db: Db, userId: string): Promise<number | null> {
  try {
    const { count, error } = await db.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
    return error || typeof count !== "number" ? null : count;
  } catch {
    return null;
  }
}

/**
 * Who the caller is, one server pass. A failed lookup is a 503 and a retry (never "no workspace"), captured in error_events.
 * No session: 200 anonymous with no database call and no limiter (nothing to protect; an office behind one address, or a CI runner, shares no window).
 * A session: limited per USER, the id from the locally verified claims (no network), never per IP.
 */
export const GET = route("/api/auth/identity", async (request) => {
  try {
    const client = await userClient(request);
    const claims = await getClaims(client, bearerToken(request) ?? undefined);
    if (!claims) return Response.json(EMPTY_IDENTITY, { headers: NO_STORE });
    const limited = await checkRateLimit(hostScopedKey(`user:${claims.userId}`));
    if (limited) return limited;
    const identity = await resolveIdentity(client, { claims });
    if (request.headers.get("x-shell-bundle") !== "1" || !identity.user) return Response.json(identity, { headers: NO_STORE });
    const org = Promise.resolve(identity.orgId && identity.role ? { orgId: identity.orgId, role: identity.role } : null);
    const [bootstrap, unreadCount] = await Promise.all([loadBootstrapBundle(client, claims.userId, undefined, { org, isAdmin: identity.isPlatformAdmin }).catch(() => null), readUnreadCount(client, claims.userId)]);
    return Response.json({ ...identity, bootstrap, unreadCount }, { headers: NO_STORE });
  } catch (e) {
    await captureError({ side: "server", route: "/api/auth/identity", error: e });
    return Response.json({ error: "identity_lookup_failed" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "1" } });
  }
});
