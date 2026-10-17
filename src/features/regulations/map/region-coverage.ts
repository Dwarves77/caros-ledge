// Ported from old_repo/src/lib/coverage-gaps.ts (lines 1-81)
// Ported from old_repo/src/lib/coverage-gaps-rollup.ts (lines 1-88)
// The coverage layer of the map (P2-03's hand-off): for each priority region (the ONE Tier-1 list), how many of its jurisdictions the source registry covers fully (an environmental body AND a
// legislature), partly, or not at all. Read on the caller's client (the registry is a member read); a failed read throws, and the old all-gap fallback (which painted an outage as "nothing is
// covered") is gone: the rail says the snapshot did not load.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db/query";
import { TIER1_REGIONS, type PriorityRegion } from "@/core/jurisdictions";
import { classifySourceType } from "@/core/sources";

export interface SourceRow {
  name: string | null;
  url: string | null;
  jurisdictions: string[] | null;
  source_type: string[] | null;
}
export interface RegionCoverage {
  region: PriorityRegion;
  covered: number;
  partial: number;
  gap: number;
  total: number;
}

/** A source's types: the stored ones, else the classifier's reading of its name and address. */
export const sourceTypesFor = (row: SourceRow): string[] => (Array.isArray(row.source_type) && row.source_type.length > 0 ? row.source_type : classifySourceType({ name: row.name, url: row.url }));

/** Each region's jurisdictions as covered (both an environmental body and a legislature), partial (some source) or a gap (none). */
export function rollupRegions(rows: readonly SourceRow[], regions: ReadonlyArray<PriorityRegion> = TIER1_REGIONS): RegionCoverage[] {
  const hits = new Map<string, { env: boolean; leg: boolean; n: number }>();
  for (const row of rows) {
    const types = sourceTypesFor(row);
    for (const iso of Array.isArray(row.jurisdictions) ? row.jurisdictions : []) {
      const h = hits.get(iso) ?? { env: false, leg: false, n: 0 };
      h.n += 1;
      h.env ||= types.includes("environmental_body");
      h.leg ||= types.includes("legislature");
      hits.set(iso, h);
    }
  }
  return regions.map((region) => {
    let covered = 0;
    let partial = 0;
    let gap = 0;
    for (const j of region.jurisdictions) {
      const h = hits.get(j.iso);
      if (!h || h.n === 0) gap += 1;
      else if (h.env && h.leg) covered += 1;
      else partial += 1;
    }
    return { region, covered, partial, gap, total: region.jurisdictions.length };
  });
}

/** The coverage of every priority region from the active, public sources. A failed read throws. */
export async function readRegionCoverage(db: Db): Promise<RegionCoverage[]> {
  const rows = await fetchAllRows<SourceRow>((from, to) => db.from("sources").select("name, url, jurisdictions, source_type").eq("status", "active").eq("admin_only", false).order("id", { ascending: true }).range(from, to) as never, { pageSize: 1000, cap: 50_000 });
  return rollupRegions(rows);
}
