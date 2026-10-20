// Ported from old_repo/src/lib/jurisdictions/iso.ts (lines 1-222)
// ISO jurisdiction codes and their display labels. The labels are DATA (data/countries.json), never read from Intl at runtime: the server and the browser answer from the same
// table, so a label cannot differ between the first paint and hydration (the old tree printed 14 EU members as raw codes).
import { z } from "zod";

import countriesJson from "./data/countries.json";
import subdivisionsJson from "./data/subdivisions.json";
import tiersJson from "./data/tiers.json";

const COUNTRIES = z.record(z.string().regex(/^[A-Z]{2}$/), z.string().min(1)).parse(countriesJson);

/** Supranational and non-country scopes an item may carry in `jurisdiction_iso`. */
const FREE_TEXT_LABELS: Readonly<Record<string, string>> = { EU: "European Union", GLOBAL: "Global", IMO: "International Maritime Organization", ICAO: "International Civil Aviation Organization" };

const COUNTRY = /^[A-Z]{2}$/;
const SUBDIVISION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

/** The `jurisdiction_iso` column as an array, or undefined when it is not one. */
export const normalizeJurisdictionIsoColumn = (value: unknown): string[] | undefined => (Array.isArray(value) ? (value as string[]) : undefined);

export function isIso(code: unknown): code is string {
  return typeof code === "string" && (code in FREE_TEXT_LABELS || COUNTRY.test(code) || SUBDIVISION.test(code));
}

/** The country part of a code ("US-CA" is "US"); null for a supranational scope or a malformed code. */
export function countryOf(code: string): string | null {
  if (typeof code !== "string" || code in FREE_TEXT_LABELS) return null;
  return COUNTRY.test(code) ? code : SUBDIVISION.test(code) ? code.slice(0, 2) : null;
}

/** A country code's name from the table; the code itself when the table has none (never a guess). */
export const countryLabel = (code: string): string => COUNTRIES[code] ?? code;

/**
 * Subdivision names: the named jurisdictions of the priority regions (data/tiers.json: the fifty states, the provinces, the nations) plus the subdivisions the tier table lists by code alone (data/subdivisions.json). One
 * source of names, so the coverage view and a row label cannot disagree, and no state shows as a raw code (register core:41). tests/derived asserts every subdivision the tier table lists has a name here.
 */
const SUBDIVISIONS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries((tiersJson as { tier1Regions: { jurisdictions: { iso: string; name: string }[] }[] }).tier1Regions.flatMap((r) => r.jurisdictions).filter((j) => j.iso.includes("-")).map((j) => [j.iso, j.name])),
  ...z.record(z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/), z.string().min(1)).parse(subdivisionsJson),
});

/** "California, United States", "Germany", "European Union"; "" for an empty code and the code itself for one the tables do not know. */
export function isoToDisplayLabel(code: string): string {
  if (typeof code !== "string" || code.length === 0) return "";
  if (code in FREE_TEXT_LABELS) return FREE_TEXT_LABELS[code] as string;
  if (COUNTRY.test(code)) return countryLabel(code);
  if (SUBDIVISION.test(code)) {
    const sub = SUBDIVISIONS[code];
    const country = COUNTRIES[code.slice(0, 2)];
    return sub && country ? `${sub}, ${country}` : sub ? sub : country ? `${code}, ${country}` : code;
  }
  return code;
}
