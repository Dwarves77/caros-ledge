// Ported from old_repo/src/lib/constants.ts (lines 11-17)
// Ported from old_repo/src/lib/constants.ts (lines 19-141)
// Ported from old_repo/src/lib/constants.ts (lines 143-206)
// Ported from old_repo/src/components/onboarding/NoWorkspaceLanding.tsx (lines 397-406)
// Ported from old_repo/src/lib/community/profile-policy.mjs (lines 4-4)
import { z } from "zod";

import jurisdictions from "./data/jurisdictions.json";
import modes from "./data/modes.json";
import regions from "./data/regions.json";
import sectors from "./data/sectors.json";

const id = z.string().min(1);
const sectorSchema = z.array(z.object({ id, label: id, highlighted: z.boolean().optional() })).min(1);
const jurisdictionSchema = z.array(z.object({ id, label: id, region: id })).min(1);
const regionSchema = z.array(z.object({ id, label: id })).min(1);
const modeSchema = z.array(z.object({ id, label: id, short: id })).min(1);

export type SectorDef = z.infer<typeof sectorSchema>[number];
export type JurisdictionDef = z.infer<typeof jurisdictionSchema>[number];
export type ModeDef = z.infer<typeof modeSchema>[number];
export type RegionDef = z.infer<typeof regionSchema>[number];

function unique<T extends { id: string }>(name: string, rows: T[]): readonly T[] {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error(`${name}: duplicate id`);
  return Object.freeze(rows);
}

/** The 40 freight sectors a workspace selects in workspace_settings.sector_profile. `highlighted` marks the six specialised niches (one flag, not a second list). */
export const ALL_SECTORS = unique("sectors.json", sectorSchema.parse(sectors));
export const HIGHLIGHTED_SECTOR_IDS: ReadonlySet<string> = new Set(ALL_SECTORS.filter((s) => s.highlighted).map((s) => s.id));
/** The 84 jurisdictions a profile or briefing can name, each in its region group. */
export const JURISDICTIONS = unique("jurisdictions.json", jurisdictionSchema.parse(jurisdictions));
export const MODES = unique("modes.json", modeSchema.parse(modes));
/** The coarse regions a profile's `region` column holds (profiles.region), as the organisation form offers them. */
export const REGIONS = unique("regions.json", regionSchema.parse(regions));

/** A jurisdiction display label to its region group ("Asia-Pacific"); "" for an unknown label, so a caller falls back to the label and never to a guess. */
export function regionGroupForLabel(label: string): string {
  return typeof label === "string" && label ? (JURISDICTIONS.find((j) => j.label === label)?.region ?? "") : "";
}
