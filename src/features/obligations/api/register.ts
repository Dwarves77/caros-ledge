// Ported from old_repo/src/app/api/obligations/register/route.ts (lines 51-137)
// GET /api/obligations/register: the list variant (paged, filtered, next-due order, meta on the true first load) and the detail variant (`itemId`, a uuid or a
// legacy id). BUILD-PLAN ruling 3: no public reads: the caller is signed in (requireUser, which also rate-limits). A failed read is a 503 with Retry-After,
// never an empty 200 and never a 500 with a cache header. The register is RLS-bound (the caller's own client).
import { LookupError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { resolveItemUuid } from "@/core/shared/ids";

import { buildRegisterQuerySpec, DUE_WINDOWS, fetchObligationRegisterPage } from "../read/register-read";
import { fetchForwardEventCount, fetchRegisterFacetOptions } from "../read/register-facets";

export const obligationsClock = { now: (): Date => new Date() };

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const GET = route("/api/obligations/register", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const params = new URL(request.url).searchParams;
  const itemIdParam = params.get("itemId");
  const variant = itemIdParam ? "detail" : "list";
  const jurisdiction = params.get("jurisdiction");
  const mode = params.get("mode");
  const bindingPosition = params.get("bindingPosition");
  const dueWindowRaw = params.get("dueWindow");
  const dueWindow = dueWindowRaw && (DUE_WINDOWS as readonly string[]).includes(dueWindowRaw) ? dueWindowRaw : "all";
  const offset = intParam(params.get("offset"), 0, 0, 100_000);
  const limit = intParam(params.get("limit"), variant === "detail" ? 200 : 60, 1, 500);
  const isFirstLoad = variant === "list" && offset === 0 && !jurisdiction && !mode && !bindingPosition && dueWindow === "all";
  const todayIso = obligationsClock.now().toISOString().slice(0, 10);
  try {
    if (variant === "detail") {
      const itemId = await resolveItemUuid(auth.client, itemIdParam as string);
      if (!itemId) return ok({ ...auth.headers, "Cache-Control": "private, no-store" }, { rows: [], total: 0 });
      const { rows, total } = await fetchObligationRegisterPage(auth.client, buildRegisterQuerySpec({ itemId, limit, offset }, todayIso));
      return ok({ ...auth.headers, "Cache-Control": "private, no-store" }, { rows, total });
    }
    const spec = buildRegisterQuerySpec({ jurisdiction, mode, bindingPosition, dueWindow, offset, limit }, todayIso);
    const facets = isFirstLoad || spec.jurisdiction ? await fetchRegisterFacetOptions(auth.client, todayIso) : undefined;
    const { rows, total } = await fetchObligationRegisterPage(auth.client, spec, facets ? { facets } : {});
    const sourceEventCount = isFirstLoad && total === 0 ? await fetchForwardEventCount(auth.client) : undefined;
    return ok({ ...auth.headers, "Cache-Control": "private, max-age=60, stale-while-revalidate=120" }, { rows, total, sourceEventCount, facetCounts: isFirstLoad ? facets?.counts : undefined });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new LookupError("obligations register", e);
  }
});
