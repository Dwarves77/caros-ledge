// Ported from old_repo/src/app/api/dashboard/coverage/request/logic.ts (lines 10-32)
// Ported from old_repo/src/app/api/dashboard/coverage/request/route.ts (lines 1-10)
import { recordCoverageRequest, validateCoverageRequest } from "@/core/coverage";
import { serviceClient } from "@/core/db/clients";
import { HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

// POST /api/dashboard/coverage/request { subjectRef, label }: a reader asks for coverage of a gap. At most one OPEN flag per page path (INV-163); the flag is a customer demand signal for the source
// registry. The write is platform-owned (integrity_flags takes only the service role), so it goes through the narrow validated path in core/coverage and nothing else.
export const POST = route("/api/dashboard/coverage/request", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const body: unknown = await request.json().catch(() => null);
  const parsed = validateCoverageRequest(body);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  let result: Awaited<ReturnType<typeof recordCoverageRequest>>;
  try {
    result = await recordCoverageRequest(serviceClient(), parsed.value);
  } catch {
    result = { ok: false, error: "Could not record the request." };
  }
  if (!result.ok) throw new HttpError(503, result.error, { "Retry-After": "1" });
  return ok(auth.headers, { ok: true, already: result.already }, result.already ? 200 : 201);
});
