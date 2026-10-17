// Ported from old_repo/src/lib/supabase-server.ts (lines 1383-1533)
// Ported from old_repo/src/lib/nav/nav-counts.ts (lines 1-44)
// Aggregates and surface counts. A failed read is null, never an aggregate of zeros: the surface shows the count blank or a failure note (INV-263).
import type { Db } from "@/core/db";
import type { NavCountSources } from "@/ui/shell/nav-counts.server";

export interface WorkspaceAggregates {
  totalItems: number;
  byPriority: { CRITICAL: number; HIGH: number; MODERATE: number; LOW: number };
  byStatus: Record<string, number>;
  byJurisdiction: Record<string, number>;
  totalJurisdictions: number;
  lastUpdatedAt: string | null;
  bySeverity?: Record<string, number>;
  byBand?: Record<string, number>;
}

const nums = (m: unknown): Record<string, number> => Object.fromEntries(Object.entries((m ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v ?? 0)]));

function mapAggregates(data: unknown): WorkspaceAggregates {
  const raw = data as Record<string, unknown>;
  const bp = nums(raw.by_priority);
  return {
    totalItems: Number(raw.total_items ?? 0),
    byPriority: { CRITICAL: bp.CRITICAL ?? 0, HIGH: bp.HIGH ?? 0, MODERATE: bp.MODERATE ?? 0, LOW: bp.LOW ?? 0 },
    byStatus: nums(raw.by_status),
    byJurisdiction: nums(raw.by_jurisdiction),
    totalJurisdictions: Number(raw.total_jurisdictions ?? 0),
    lastUpdatedAt: typeof raw.last_updated_at === "string" ? raw.last_updated_at : null,
  };
}

/** The org's aggregates; null on any failure. */
export async function readAggregates(db: Db, orgId: string): Promise<WorkspaceAggregates | null> {
  try {
    const { data, error } = await db.rpc("get_workspace_intelligence_aggregates", { p_org_id: orgId });
    return error || !data ? null : mapAggregates(data);
  } catch {
    return null;
  }
}

/** One surface's counts for a member's org, with the severity and band tallies; null on failure. A null org is accepted by the database for the service role only (migration 361), so a page read on the member's own client passes the member's org. */
export async function readSurfaceCounts(db: Db, orgId: string | null, surface: string): Promise<WorkspaceAggregates | null> {
  try {
    const { data, error } = await db.rpc("get_surface_counts", { p_org_id: orgId, p_surface: surface });
    if (error || !data) return null;
    const raw = data as Record<string, unknown>;
    return { ...mapAggregates(data), bySeverity: nums(raw.by_severity), byBand: nums(raw.by_band) };
  } catch {
    return null;
  }
}

/** The four VERIFIED surface counts from the one all-surfaces RPC (the customer rail counts verified items, ruling 1: the same number the surface's own tiles show); null on failure or when a count is missing. */
export async function readSurfaceTotals(db: Db, orgId: string): Promise<{ regulations: number; marketIntel: number; research: number; operations: number } | null> {
  try {
    const { data, error } = await db.rpc("get_all_surface_counts", { p_org_id: orgId });
    if (error || !data) return null;
    const verified = (key: string) => Number((data as Record<string, { verified?: number } | undefined>)[key]?.verified ?? Number.NaN);
    const out = { regulations: verified("regulations"), marketIntel: verified("market"), research: verified("research"), operations: verified("operations") };
    return Object.values(out).some(Number.isNaN) ? null : out;
  } catch {
    return null;
  }
}

/** The three reads behind the nav counts, for `getNavCounts` (P2-08 wires this as the bootstrap route's navCounts dependency). */
export function navCountSources(db: Db, who: { orgId: string; userId: string }): NavCountSources {
  return {
    surfaces: () => readSurfaceTotals(db, who.orgId),
    priorities: async () => (await readAggregates(db, who.orgId))?.byPriority ?? null,
    watchlist: async () => {
      const { count, error } = await db.from("user_watchlist").select("item_id", { count: "exact", head: true }).eq("user_id", who.userId);
      return error || typeof count !== "number" ? null : count;
    },
  };
}
