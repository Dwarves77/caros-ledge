// Ported from old_repo/src/lib/nav/nav-counts.ts (lines 1-44)
// The nav counts for the bootstrap route. The three reads are handed in (features/lists/counts.ts supplies them), so this file imports no data layer.
// A count that could not be read is null: the nav prints nothing beside it. Any failure is never rendered as a zero (INV-263).

export interface NavCounts {
  regulations: number | null;
  market: number | null;
  research: number | null;
  operations: number | null;
  watchlist: number | null;
  /** The priority tallies behind the nav's band rule; null when unknown (the rule then draws no split). */
  byPriority: { CRITICAL: number; HIGH: number; MODERATE: number; LOW: number } | null;
}

export interface NavCountSources {
  surfaces: () => Promise<{ regulations: number; marketIntel: number; research: number; operations: number } | null>;
  watchlist: () => Promise<number | null>;
  priorities: () => Promise<{ CRITICAL: number; HIGH: number; MODERATE: number; LOW: number } | null>;
}

const settle = async <T>(read: () => Promise<T | null>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

export async function getNavCounts(src: NavCountSources): Promise<NavCounts> {
  const [surfaces, watchlist, byPriority] = await Promise.all([settle(src.surfaces), settle(src.watchlist), settle(src.priorities)]);
  return { regulations: surfaces?.regulations ?? null, market: surfaces?.marketIntel ?? null, research: surfaces?.research ?? null, operations: surfaces?.operations ?? null, watchlist, byPriority };
}
