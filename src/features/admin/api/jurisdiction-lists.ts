// Ported from old_repo/src/lib/jurisdictions/tiers.ts (lines 1-213)
// Ported from old_repo/src/lib/jurisdictions/iso.ts (lines 1-60)
// The country-level tier lists, the ISO shape test and the label for the coverage matrix. P2-10 (core/jurisdictions) was not on main when this slice landed, so this file
// carries only what the admin coverage handler and the coverage page need; when P2-10 merges, the two imports of this file are swapped for @/core/jurisdictions and this file is deleted.

/** Tier 1: the countries (and the EU) the platform must cover. A sub-national code takes the tier of its country. */
export const TIER1: readonly string[] = [
  "US", "EU", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "GB", "CA", "AU", "SG", "HK", "JP", "KR",
];
/** Tier 2: the countries the platform should cover. */
export const TIER2: readonly string[] = ["CH", "NO", "IS", "AE", "SA", "IL", "TR", "CN", "MO", "IN", "BR", "MX", "AR", "CL", "CO", "PE", "ZA", "EG", "MA", "NZ", "ID", "TH", "MY", "VN", "PH"];

/** Free-text supranational codes the platform accepts beside ISO 3166. */
const FREE_TEXT = new Set(["EU", "GLOBAL", "IMO", "ICAO", "OECD", "ASEAN"]);
/** True when the code is an ISO 3166-1 alpha-2 country, an ISO 3166-2 sub-region of one, or a known free-text code. */
export const isIso = (code: string): boolean => FREE_TEXT.has(code) || /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code);
/** True for an ISO 3166-2 code ("US-CA"); the hyphen is the discriminator. */
export const subnational = (code: string): boolean => code.includes("-");
/** The country segment of a code, or the code itself for a supranational one. */
export const countryOf = (code: string): string => (subnational(code) ? (code.split("-")[0] as string) : code);

const names = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
/** A readable name for a code: the region name for a country, the code itself where no name exists (never a made-up label). */
export function countryLabel(code: string): string {
  if (subnational(code) || !/^[A-Z]{2}$/.test(code)) return code;
  try {
    const n = names?.of(code);
    return n && n !== code ? n : code;
  } catch {
    return code;
  }
}
