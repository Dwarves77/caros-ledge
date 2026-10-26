// Ported from old_repo/src/app/api/auth/identity/route.ts (lines 41-69)
import { getClaims } from "@/core/auth/claims";
import { EMPTY_IDENTITY, resolveIdentity } from "@/core/auth/identity";
import { bearerToken, userClient } from "@/core/db/clients";
import { route } from "@/core/http/errors";
import { checkRateLimit, hostScopedKey } from "@/core/http/rate-limit";
import { captureError } from "@/core/shared/telemetry";

const NO_STORE = { "Cache-Control": "private, no-store" };

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
    return Response.json(await resolveIdentity(client), { headers: NO_STORE });
  } catch (e) {
    await captureError({ side: "server", route: "/api/auth/identity", error: e });
    return Response.json({ error: "identity_lookup_failed" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "1" } });
  }
});
