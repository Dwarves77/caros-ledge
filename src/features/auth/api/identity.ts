// Ported from old_repo/src/app/api/auth/identity/route.ts (lines 41-69)
import { resolveIdentity } from "@/core/auth/identity";
import { userClient } from "@/core/db/clients";
import { route } from "@/core/http/errors";
import { checkRateLimit, clientKey } from "@/core/http/rate-limit";
import { captureError } from "@/core/shared/telemetry";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** Who the caller is, one server pass. A failed lookup is a 503 and a retry (never "no workspace"), captured in error_events. */
export const GET = route("/api/auth/identity", async (request) => {
  const limited = await checkRateLimit(clientKey(request));
  if (limited) return limited;
  try {
    return Response.json(await resolveIdentity(await userClient(request)), { headers: NO_STORE });
  } catch (e) {
    await captureError({ side: "server", route: "/api/auth/identity", error: e });
    return Response.json({ error: "identity_lookup_failed" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "1" } });
  }
});
