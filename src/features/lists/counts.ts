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

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A tally object from the database: every value a number. A key the database left out is a group with no items (a count of zero is the database's to say); a value that is not a number is a malformed reply. */
function tally(m: unknown): Record<string, number> | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    const n = count(v);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

/** The reply as aggregates, or null when a field the database always sends is missing or not a number: a malformed reply is a failed read, never a page of zeros (S:85). */
function mapAggregates(data: unknown): WorkspaceAggregates | null {
  const raw = data as Record<string, unknown>;
  const [totalItems, totalJurisdictions] = [count(raw.total_items), count(raw.total_jurisdictions)];
  const [bp, byStatus, byJurisdiction] = [tally(raw.by_priority), tally(raw.by_status), tally(raw.by_jurisdiction)];
  if (totalItems === null || totalJurisdictions === null || !bp || !byStatus || !byJurisdiction) return null;
  return {
    totalItems,
    byPriority: { CRITICAL: bp.CRITICAL ?? 0, HIGH: bp.HIGH ?? 0, MODERATE: bp.MODERATE ?? 0, LOW: bp.LOW ?? 0 },
    byStatus,
    byJurisdiction,
    totalJurisdictions,
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
    const base = mapAggregates(data);
    const [bySeverity, byBand] = [tally(raw.by_severity), tally(raw.by_band)];
    return base && bySeverity && byBand ? { ...base, bySeverity, byBand } : null;
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
