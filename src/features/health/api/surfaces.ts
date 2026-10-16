// Ported from old_repo/src/app/api/health/surfaces/route.ts (lines 1-212)
import { serviceClient, type Db } from "@/core/db/clients";
import { route } from "@/core/http/errors";
import { workerAuthGuard } from "@/core/http/guard";
import { checkRateLimit } from "@/core/http/rate-limit";
import { readGateAHealth } from "@/core/health/gate-a";
import { ALL_SURFACES, evaluateSurface, overallOk, seedLeak } from "@/core/telemetry/surface-health";

type Probe = { rows: number | null; error: string | null };
const probeFail = (e: unknown, what: string): Probe => ({ rows: null, error: e instanceof Error ? e.message : `${what} threw` });

/** Head-only COUNT(*) of a table; an error is the probe's error, never a zero. */
async function countRows(db: Db, table: string): Promise<Probe> {
  try {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
    return error ? { rows: null, error: error.message } : { rows: count ?? 0, error: null };
  } catch (e) {
    return probeFail(e, "count");
  }
}

/**
 * GET /api/health/surfaces: the worker-secret health probe. Per-surface verified counts come from the database's one surface classifier through get_all_surface_counts (no hand-typed
 * item_type families), the community and onboarding counts from their tables, two org-scoped rpc probes, the Gate A gauges and the forward-events visibility count. 200 when healthy, 503 when not.
 * Its invoker is the harness dispatcher (the workflow that called it is gone).
 */
export const GET = route("/api/health/surfaces", async (request) => {
  const denied = workerAuthGuard(request);
  if (denied) return denied;
  const limited = await checkRateLimit("worker:/api/health/surfaces");
  if (limited) return limited;
  let db: Db;
  try {
    db = serviceClient();
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "service client unavailable", surfaces: {}, rpcs: {} }, { status: 500 });
  }
  let orgId: string | null = null;
  let orgError: string | null = null;
  try {
    const { data, error } = await db.from("organizations").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (error) orgError = error.message;
    orgId = (data as { id?: string } | null)?.id ?? null;
  } catch (e) {
    orgError = e instanceof Error ? e.message : "org lookup threw";
  }

  const counts: Record<string, Probe> = {};
  const noOrg: Probe = { rows: null, error: orgError ?? "no org resolved" };
  let bySurface: Record<string, { verified?: number }> | null = null;
  let surfaceCountsError: string | null = null;
  if (orgId) {
    try {
      const { data, error } = await db.rpc("get_all_surface_counts", { p_org_id: orgId });
      if (error) surfaceCountsError = error.message;
      else bySurface = data as Record<string, { verified?: number }>;
    } catch (e) {
      surfaceCountsError = e instanceof Error ? e.message : "rpc threw";
    }
  }
  const surfaceProbe = (key: string): Probe => (!orgId ? noOrg : surfaceCountsError ? { rows: null, error: surfaceCountsError } : { rows: bySurface?.[key]?.verified ?? 0, error: null });
  counts["dashboard"] = surfaceProbe("total");
  for (const s of ["regulations", "market", "research", "operations"]) counts[s] = surfaceProbe(s);
  counts["community"] = await countRows(db, "community_posts");
  counts["map"] = counts["regulations"] as Probe; // the map is a view of Regulations content (ADR-041: no Community-derived backing)
  counts["assistant-config"] = counts["dashboard"] as Probe; // the Ask substrate: the verified items it can cite
  counts["onboarding-config"] = await countRows(db, "workspace_settings");

  const surfaces: Record<string, ReturnType<typeof evaluateSurface>> = {};
  for (const name of ALL_SURFACES) {
    const c = counts[name] ?? { rows: null, error: "not probed" };
    surfaces[name] = evaluateSurface(name, c.rows, c.error);
  }
  const rpcs: Record<string, { ok: boolean; error: string | null }> = {};
  rpcs["surface_counts"] = !orgId ? { ok: false, error: noOrg.error } : { ok: !surfaceCountsError, error: surfaceCountsError };
  if (!orgId) rpcs["market_intel"] = { ok: false, error: noOrg.error };
  else {
    try {
      const { error } = await db.rpc("get_market_intel_items", { p_org_id: orgId });
      rpcs["market_intel"] = { ok: !error, error: error?.message ?? null };
    } catch (e) {
      rpcs["market_intel"] = { ok: false, error: e instanceof Error ? e.message : "rpc threw" };
    }
  }
  const gate_a = await readGateAHealth(db, new Date());
  // Forward events a customer can see: an inner join to a LIVE parent item, the same predicate the table's read policy applies. A drop to 0 while the table holds rows means the strip has gone dark.
  const forward_events_visible_on_regulations: { count: number | null; error: string | null } = { count: null, error: null };
  try {
    const { count, error } = await db.from("item_forward_events").select("id, intelligence_items!inner(is_archived)", { count: "exact", head: true }).eq("intelligence_items.is_archived", false);
    if (error) forward_events_visible_on_regulations.error = error.message;
    else forward_events_visible_on_regulations.count = count ?? 0;
  } catch (e) {
    forward_events_visible_on_regulations.error = e instanceof Error ? e.message : "forward_events_visible_on_regulations count threw";
  }
  const ok = overallOk(surfaces, rpcs);
  return Response.json({ ok, seed_leak: seedLeak(surfaces["dashboard"]?.backing_rows ?? null), surfaces, rpcs, gate_a, forward_events_visible_on_regulations, checked_at: new Date().toISOString() }, { status: ok ? 200 : 503 });
});
