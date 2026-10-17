// Ported from old_repo/src/lib/jurisdictions/tiers.ts (lines 1-213)
// Ported from old_repo/src/lib/tier1-priority-jurisdictions.ts (lines 1-229)
// The ONE Tier-1 list: the old tree kept two (this file's and sources-b's priority regions) that differed by 22 codes. The priority regions are data (data/tiers.json) and
// Tier 1 is their union with the country-level and supranational scopes beside them; the coverage view and the tier of a code both read it.
import { z } from "zod";

import tiersJson from "./data/tiers.json";
import { countryOf, isIso } from "./iso";

const region = z.object({ id: z.string(), name: z.string(), jurisdictions: z.array(z.object({ iso: z.string(), name: z.string() })).min(1) });
const file = z.object({ tier1Regions: z.array(region).min(1), tier1Extra: z.array(z.string()), tier2: z.array(z.string()) }).parse(tiersJson);

export type PriorityRegion = z.infer<typeof region>;
/** The nine priority regions the coverage view rolls up, each with its named jurisdictions. */
export const TIER1_REGIONS: ReadonlyArray<PriorityRegion> = file.tier1Regions;
export const TIER1: ReadonlyArray<string> = [...new Set([...file.tier1Extra, ...file.tier1Regions.flatMap((r) => r.jurisdictions.map((j) => j.iso))])];
const TIER1_SET: ReadonlySet<string> = new Set(TIER1);
/** Tier 2 is whatever the table names that Tier 1 does not already hold. */
export const TIER2: ReadonlyArray<string> = file.tier2.filter((c) => !TIER1_SET.has(c));
const TIER2_SET: ReadonlySet<string> = new Set(TIER2);

/** 1 or 2 for a listed code, 3 for any other valid code, null for something that is not a code. */
export function jurisdictionTier(code: string): 1 | 2 | 3 | null {
  if (typeof code !== "string" || code.length === 0) return null;
  return TIER1_SET.has(code) ? 1 : TIER2_SET.has(code) ? 2 : isIso(code) ? 3 : null;
}
export const isSubnational = (code: string): boolean => typeof code === "string" && code.includes("-");
/** The country a subdivision belongs to, else the code itself. */
export const countryGroupForIso = (code: string): string => countryOf(code) ?? code;
