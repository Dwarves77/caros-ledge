// Ported from old_repo/src/lib/coverage/matrix-data.ts (lines 1-54)
// Ported from old_repo/src/lib/coverage/load-matrix.mjs (lines 1-47)
import { unstable_cache } from "next/cache";

import { buildCoverageMatrix, emptyCoverageMatrix, surfaceDenominator, type CoverageMatrix, type DenominatorLine } from "@/core/coverage/matrix";
import type { Db } from "@/core/db";
import { log } from "@/core/shared/log";

import { loadCoverage, type CoverageSurface } from "./census";

const COVERAGE_UNAVAILABLE = "Coverage could not be read just now.";
const REVALIDATE_SECONDS = 600;

export interface CoverageDeps {
  db: () => Db;
  now: () => string;
  /** The jurisdiction label for a code (the jurisdictions slice's), injected. */
  labelOf: (code: string) => string;
  /** The app-data cache tag the surface read layer revalidates. */
  tag: string;
}
/** The matrix: the census read ONCE (the same entries and counts feed the build). A failure is an error state with an empty matrix, and the cause is logged. */
async function loadCoverageMatrix(deps: Pick<CoverageDeps, "db" | "now" | "labelOf">): Promise<{ matrix: CoverageMatrix; error: string | null }> {
  const generatedAt = deps.now();
  try {
    const { entries, counts } = await loadCoverage(deps.db());
    return { matrix: buildCoverageMatrix(entries, { generatedAt, verifiedBriefs: counts.verifiedBriefs, labelOf: deps.labelOf }), error: null };
  } catch (e) {
    log.warn(`[coverage] matrix read failed: ${(e as Error).message}`);
    return { matrix: emptyCoverageMatrix(generatedAt), error: COVERAGE_UNAVAILABLE };
  }
}
/** One surface's denominator line data, or null with an error when the read failed. */
export async function loadSurfaceDenominator(surface: CoverageSurface, deps: Pick<CoverageDeps, "db">): Promise<{ denominator: DenominatorLine | null; error: string | null }> {
  try {
    const { counts } = await loadCoverage(deps.db(), surface);
    const denominator = surfaceDenominator(surface, counts);
    return { denominator, error: denominator ? null : COVERAGE_UNAVAILABLE };
  } catch (e) {
    log.warn(`[coverage] ${surface} denominator read failed: ${(e as Error).message}`);
    return { denominator: null, error: COVERAGE_UNAVAILABLE };
  }
}

/** The cached readers, bound to their dependencies. A thrown outage is never stored by unstable_cache, so an outage is never cached. */
export function makeCoverageData(deps: CoverageDeps) {
  const cachedMatrix = unstable_cache(
    async (): Promise<CoverageMatrix> => {
      const out = await loadCoverageMatrix(deps);
      if (out.error) throw new Error(out.error);
      return out.matrix;
    },
    ["coverage-matrix-v1"],
    { revalidate: REVALIDATE_SECONDS, tags: [deps.tag] },
  );
  const cachedDenominator = unstable_cache(
    async (surface: CoverageSurface): Promise<DenominatorLine> => {
      const out = await loadSurfaceDenominator(surface, deps);
      if (out.error || !out.denominator) throw new Error(out.error ?? COVERAGE_UNAVAILABLE);
      return out.denominator;
    },
    ["coverage-denominator-v1"],
    { revalidate: REVALIDATE_SECONDS, tags: [deps.tag] },
  );
  return {
    async getCoverageMatrix(): Promise<{ matrix: CoverageMatrix; error: string | null }> {
      try {
        return { matrix: await cachedMatrix(), error: null };
      } catch (e) {
        log.warn(`[coverage] cached matrix unavailable: ${(e as Error).message}`);
        return { matrix: emptyCoverageMatrix(deps.now()), error: COVERAGE_UNAVAILABLE };
      }
    },
    async getSurfaceDenominator(surface: CoverageSurface): Promise<{ denominator: DenominatorLine | null; error: string | null }> {
      try {
        return { denominator: await cachedDenominator(surface), error: null };
      } catch (e) {
        log.warn(`[coverage] cached ${surface} denominator unavailable: ${(e as Error).message}`);
        return { denominator: null, error: COVERAGE_UNAVAILABLE };
      }
    },
  };
}
