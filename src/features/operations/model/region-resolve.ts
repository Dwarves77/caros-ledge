// Ported from old_repo/src/lib/operations/region-crosswalk.mjs (lines 13-27)
// Ported from old_repo/src/lib/agent/formats/operations-matrix.ts (lines 96-126)
// The one jurisdiction-to-region rule (the old tree wrote it twice with different return shapes): an item belongs to every region whose code or ISO set holds ANY of its jurisdiction codes, over the item's
// whole list (structured ISO codes, the jurisdictions column and the legacy single value), in roster order. The caller that wants one region takes the first.
export interface RosterRegion {
  code: string;
  isoCodes?: readonly string[] | null;
}
export interface ItemJurisdictions {
  jurisdictionIso?: readonly string[] | null | undefined;
  jurisdictions?: readonly string[] | null | undefined;
  jurisdiction?: string | null | undefined;
}

/** The item's jurisdiction codes, upper-cased and de-duplicated. */
export function itemJurisdictionCodes(item: ItemJurisdictions): string[] {
  const all = [...(item.jurisdictionIso ?? []), ...(item.jurisdictions ?? []), item.jurisdiction ?? ""];
  return [...new Set(all.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim().toUpperCase()))];
}

/** Every region code (roster order) whose code or ISO set holds any of the item's codes; none when the item names no jurisdiction. */
export function regionsForItem(roster: readonly RosterRegion[], item: ItemJurisdictions): string[] {
  const codes = itemJurisdictionCodes(item);
  return roster.filter((r) => {
    const own = new Set([r.code, ...(r.isoCodes ?? [])].map((c) => String(c).toUpperCase()));
    return codes.some((c) => own.has(c));
  }).map((r) => r.code);
}
