// Ported from old_repo/src/app/api/obligations/upcoming/route.ts (lines 56-140)
// GET /api/obligations/upcoming: the upcoming strip. List variant scoped by the caller's workspace profile, by the URL facets (`?scope=1`: modes, regions) or
// widened (`?scope=all`); detail variant for one item (`itemId`, a uuid or legacy id). BUILD-PLAN ruling 3: signed-in callers only. The RULING on the old
// soft-fail: a failed read is a 503 with Retry-After, never an empty 200 (an outage must not read as "no obligations"). Scope is resolved once.
import { currentMembership } from "@/core/auth/membership";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { resolveItemUuid } from "@/core/shared/ids";
import { getWorkspaceProfile } from "@/core/workspace";

import { defaultJurisdictionFilter, readUpcoming, resolveScope, scopeLabel, type Scope } from "../read/upcoming-read";

import { obligationsClock } from "./register";

export const GET = route("/api/obligations/upcoming", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const params = new URL(request.url).searchParams;
  const itemIdParam = params.get("itemId");
  const limitParam = params.get("limit");
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Number(limitParam) : undefined;
  const variant = itemIdParam ? "detail" : "list";
  const scopeParam = variant === "list" ? params.get("scope") : null;
  const scoped = scopeParam === "1";
  const widened = scopeParam === "all";
  const headers = { ...auth.headers, "Cache-Control": "private, no-store" };
  const todayIso = obligationsClock.now().toISOString().slice(0, 10);
  try {
    let itemId: string | null = null;
    if (variant === "detail") {
      itemId = await resolveItemUuid(auth.client, itemIdParam as string);
      if (!itemId) return ok(headers, { events: [], hasJurisdictionFilter: false });
    }
    let jurisdictionFilter: string[] | null = null;
    let modeFilter: string[] | null = null;
    let resolved: Scope | null = null;
    if (variant === "list" && !widened) {
      const membership = await currentMembership(auth.client, auth.userId);
      const profile = await getWorkspaceProfile(auth.client, membership?.orgId ?? null);
      if (scoped) {
        resolved = resolveScope({ facetModes: params.get("modes"), facetRegions: params.get("regions"), profileModes: profile.transportModes, profileJurisdictions: profile.jurisdictions });
        jurisdictionFilter = resolved.regions;
        modeFilter = resolved.modes;
      } else jurisdictionFilter = defaultJurisdictionFilter(profile.jurisdictions);
    }
    const { events, hiddenByScope } = await readUpcoming(auth.client, { itemId, limit: limit ?? (variant === "detail" ? 20 : 8), jurisdictionFilter, modeFilter, countHidden: scoped }, todayIso);
    const body: Record<string, unknown> = { events, hasJurisdictionFilter: !!jurisdictionFilter };
    if (scoped && resolved) {
      body.scope = { modes: resolved.modes, regions: resolved.regions, source: resolved.source, label: scopeLabel(resolved) };
      body.hiddenByScope = hiddenByScope ?? 0;
    }
    return ok(headers, body);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new LookupError("obligations upcoming", e);
  }
});
