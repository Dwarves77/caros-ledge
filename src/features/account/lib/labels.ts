// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 71-80)
// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 110-111)
import { ALL_SECTORS, HIGHLIGHTED_SECTOR_IDS, JURISDICTIONS } from "@/core/workspace";

const SECTOR_LABEL = new Map<string, string>(ALL_SECTORS.map((s) => [s.id, s.label]));
const JURISDICTION_LABEL = new Map<string, string>(JURISDICTIONS.map((j) => [j.id, j.label]));

/** A stored id to its label; an id the vocabulary no longer holds shows as itself, never dropped. */
export const sectorLabels = (ids: readonly string[]): string[] => ids.map((id) => SECTOR_LABEL.get(id) ?? id);
export const jurisdictionLabels = (ids: readonly string[]): string[] => ids.map((id) => JURISDICTION_LABEL.get(id) ?? id);
/** How many of the ids are the six highlighted niches. */
export const highlightedCount = (ids: readonly string[]): number => ids.filter((id) => HIGHLIGHTED_SECTOR_IDS.has(id)).length;
