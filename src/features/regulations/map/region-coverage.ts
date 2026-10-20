// Ported from old_repo/src/lib/coverage-gaps.ts (lines 1-81)
// Ported from old_repo/src/lib/coverage-gaps-rollup.ts (lines 1-88)
// The coverage layer of the map (P2-03's hand-off): for each priority region (the ONE Tier-1 list), how many of its jurisdictions the COLLECTED sources of the registry cover fully (an environmental body AND a
// legislature), partly, or not at all. A registered source that is not yet collected (the source_coverage view) is not coverage, and the read says how many sources it left out and why (register surfaces:11). Read on the caller's client (the registry is a member read); a failed read throws, and the old all-gap fallback (which painted an outage as "nothing is
// covered") is gone: the rail says the snapshot did not load.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db/query";
import { TIER1_REGIONS, type PriorityRegion } from "@/core/jurisdictions";
import { classifySourceType } from "@/core/sources";
import { readCollectedSourceIds } from "@/core/derived/source-coverage";

export interface SourceRow {
  id?: string;
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
const sourceTypesFor = (row: SourceRow): string[] => (Array.isArray(row.source_type) && row.source_type.length > 0 ? row.source_type : classifySourceType({ name: row.name, url: row.url }));

/** Each region's jurisdictions as covered (both an environmental body and a legislature), partial (some source) or a gap (none). */
function rollupRegions(rows: readonly SourceRow[], regions: ReadonlyArray<PriorityRegion> = TIER1_REGIONS): RegionCoverage[] {
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

export interface RegionCoverageRead {
  regions: RegionCoverage[];
  /** Active public sources left out because they are not yet collected (no admissible item), and collected ones left out because no type could be read for them. */
  notCollected: number;
  untyped: number;
}

/** The coverage of every priority region from the active, public sources that are COLLECTED, with how many sources it did not count and why. A failed read throws. */
export async function readRegionCoverage(db: Db): Promise<RegionCoverageRead> {
  const [rows, collected] = await Promise.all([
    fetchAllRows<SourceRow>((from, to) => db.from("sources").select("id, name, url, jurisdictions, source_type").eq("status", "active").eq("admin_only", false).order("id", { ascending: true }).range(from, to) as never, { pageSize: 1000, cap: 50_000 }),
    readCollectedSourceIds(db),
  ]);
  const counted = rows.filter((r) => r.id !== undefined && collected.has(r.id));
  const typed = counted.filter((r) => sourceTypesFor(r).length > 0);
  return { regions: rollupRegions(typed), notCollected: rows.length - counted.length, untyped: counted.length - typed.length };
}
