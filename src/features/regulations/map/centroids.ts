// Ported from old_repo/src/components/map/jurisdictionCentroids.ts (lines 1-37)
// Where a jurisdiction is drawn, keyed by ISO code (data/centroids.json: 94 countries and the four supranational scopes, each with its region group). The legacy groupings with no code (Nordic,
// ASEAN, GCC ...) keep their old centroid and are used only for a row that has no jurisdiction_iso. A key with no centroid is "not charted": the register still lists it and says so.
import { z } from "zod";

import centroidsJson from "./data/centroids.json";

const entry = z.tuple([z.number(), z.number(), z.string()]);
const file = z.object({ countries: z.record(z.string(), entry), groupings: z.record(z.string(), entry) }).parse(centroidsJson);

const CENTROIDS: Readonly<Record<string, readonly [number, number, string]>> = { ...file.groupings, ...file.countries };
export const centroidOf = (key: string): [number, number] | null => {
  const c = CENTROIDS[key] ?? CENTROIDS[key.toUpperCase()] ?? null;
  return c ? [c[0], c[1]] : null;
};
/** The region group ("Europe") of a key, or "" when none is recorded. */
export const regionGroupOf = (key: string): string => CENTROIDS[key]?.[2] ?? CENTROIDS[key.toUpperCase()]?.[2] ?? "";
