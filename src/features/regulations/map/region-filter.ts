// Ported from old_repo/src/app/map/page.tsx (lines 28-40)
import { TIER1, TIER1_REGIONS } from "@/core/jurisdictions";

/** The codes a `?region=` names: a priority region's jurisdictions, one priority code, else nothing (an unknown value filters nothing, it does not empty the map). */
export function regionCodes(raw: string | null | undefined): string[] | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const region = TIER1_REGIONS.find((r) => r.id === v.toLowerCase());
  if (region) return region.jurisdictions.map((j) => j.iso.toUpperCase());
  return TIER1.includes(v.toUpperCase()) ? [v.toUpperCase()] : null;
}
