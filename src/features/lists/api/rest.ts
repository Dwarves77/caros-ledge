// Ported from old_repo/src/app/api/listings/rest/route.ts (lines 1-60)
// GET /api/listings/rest?surface=regulations: the rest of a list after its first page, for the caller's workspace. Signed-in callers only (requireUser, which rate-limits per user). A failed read is a
// 503 with Retry-After: the list says "the rest did not load" with Retry and never presents the first page as the whole list (INV-263).
import { currentMembership } from "@/core/auth/membership";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { readRegulationsRemainder } from "@/features/regulations/list-read";

const SURFACES: Record<string, (db: Parameters<typeof readRegulationsRemainder>[0], orgId: string | null) => Promise<{ rows: unknown[]; failed: boolean }>> = { regulations: readRegulationsRemainder };

export const GET = route("/api/listings/rest", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const read = SURFACES[new URL(request.url).searchParams.get("surface") ?? ""];
  if (!read) throw new HttpError(400, "surface must name a list");
  const membership = await currentMembership(auth.client, auth.userId);
  const result = await read(auth.client, membership?.orgId ?? null).catch((e: unknown) => {
    throw new LookupError("listings", e);
  });
  if (result.failed) throw new LookupError("listings", new Error("the listing read failed"));
  return ok({ ...auth.headers, "Cache-Control": "private, no-store" }, { resources: result.rows });
});
