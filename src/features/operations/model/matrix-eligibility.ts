// Ported from old_repo/src/lib/agent/formats/operations-matrix.ts (lines 128-284)
// Ported from old_repo/src/components/operations/OperationsDetailSurface.tsx (lines 146-170)
// The S3/S4 gate of an Operations profile (INV-233), pure: a dimension is eligible when at least two regions hold sourced data for it INCLUDING a region of the item's own (over the item's WHOLE jurisdiction list;
// the old page passed one value), and ONE note builder says why a section is omitted, rendered in place of the section. A coverage read that failed gates every dimension closed and says so.
import { DIMENSIONS, type OperationsDimension } from "./dimensions";
import { regionsForItem, type ItemJurisdictions, type RosterRegion } from "./region-resolve";

export interface SourcedCoverage {
  regionCode: string;
  dimension: string;
  state: string;
}
export interface DimensionEligibility {
  dimension: OperationsDimension;
  eligible: boolean;
  sourcedRegionCount: number;
  itemJurisdictionPresent: boolean;
}
export interface MatrixEligibility {
  s3Eligible: boolean;
  /** S4 is transitive over S3. */
  s4Eligible: boolean;
  dimensions: DimensionEligibility[];
  resolvedRegionCodes: string[];
  /** Set when the gate is closed for want of data (a failed read), as opposed to want of coverage. */
  unavailable: string | null;
}

/** A region is sourced for a dimension when its coverage row is populated or partial. */
const SOURCED = new Set(["populated", "partial"]);

export function checkMatrixEligibility(i: { roster: readonly RosterRegion[]; coverage: readonly SourcedCoverage[]; item: ItemJurisdictions }): MatrixEligibility {
  const resolved = regionsForItem(i.roster, i.item);
  const mine = new Set(resolved.map((c) => c.toUpperCase()));
  const dimensions = DIMENSIONS.map((d): DimensionEligibility => {
    const sourced = [...new Set(i.coverage.filter((c) => c.dimension === d.db && SOURCED.has(c.state)).map((c) => c.regionCode))];
    const present = sourced.some((c) => mine.has(c.toUpperCase()));
    return { dimension: d.db, sourcedRegionCount: sourced.length, itemJurisdictionPresent: present, eligible: sourced.length >= 2 && present };
  });
  const s3 = dimensions.some((d) => d.eligible);
  return { s3Eligible: s3, s4Eligible: s3, dimensions, resolvedRegionCodes: resolved, unavailable: null };
}
/** The gate closed because a read failed: every dimension ineligible, the reason stated. */
export const eligibilityUnavailable = (reason: string): MatrixEligibility => ({ s3Eligible: false, s4Eligible: false, dimensions: DIMENSIONS.map((d) => ({ dimension: d.db, eligible: false, sourcedRegionCount: 0, itemJurisdictionPresent: false })), resolvedRegionCodes: [], unavailable: reason });

/** The one note rendered in place of an omitted comparison section ("3" cost comparison, "4" cross-regional), naming why: unavailable data, no multi-region coverage, or the item's own region missing. */
export function omitNote(sectionKey: "3" | "4", e: MatrixEligibility | null | undefined): string {
  const what = sectionKey === "3" ? "Cost comparison" : "Cross-regional comparison";
  if (!e || e.unavailable) return `${what} is not available because the coverage data could not be read. Reload to try again.`;
  const short = e.dimensions.filter((d) => !d.eligible);
  if (short.length === 0) return `${what} is available.`;
  if (short.every((d) => d.sourcedRegionCount === 0)) return `${what} is not yet available: no dimension has sourced data in any region.`;
  const region = e.resolvedRegionCodes.join(", ") || "this item's jurisdiction";
  if (e.resolvedRegionCodes.length === 0) return `${what} needs this item's jurisdiction to match a covered region, and it does not.`;
  if (short.some((d) => d.sourcedRegionCount >= 2 && !d.itemJurisdictionPresent)) return `${what} needs ${region} to have sourced coverage, and it does not yet.`;
  return `${what} needs sourced data in at least two regions for a dimension, including ${region}.`;
}

