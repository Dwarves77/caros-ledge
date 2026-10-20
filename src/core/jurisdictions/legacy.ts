// Ported from old_repo/src/lib/constants.ts (lines 19-141)
// The legacy single-slug jurisdiction vocabulary against the ISO one. ISO is the model; a legacy slug maps to a code ONLY where an old row carries no `jurisdiction_iso`.
// The 84 slugs and their region groups are P2-02's core/workspace/vocabulary; this adds the slug-to-code table. A slug that names a grouping (nordic, asean, gcc ...) has no code.
import { JURISDICTIONS, regionGroupForLabel } from "@/core/workspace/vocabulary";

import legacyJson from "./data/legacy-iso.json";
import { isIso, isoToDisplayLabel } from "./iso";

const TABLE: Readonly<Record<string, string>> = legacyJson;
/** The first legacy slug of each code, built once (a lookup per row scanned the table). */
const SLUG_OF_CODE: ReadonlyMap<string, string> = new Map(Object.keys(TABLE).reverse().map((slug) => [TABLE[slug] as string, slug]));

/** The ISO code for a legacy slug, or null for a grouping with no single code (and for anything unknown). */
export const legacyToIso = (slug: string | null | undefined): string | null => (slug ? (TABLE[slug.toLowerCase()] ?? null) : null);

/** The jurisdiction codes of a row: its `jurisdiction_iso` when it has one, else the code of its legacy slug, else none. */
export function isoCodesOf(row: { jurisdictionIso?: readonly string[] | undefined; jurisdiction?: string | undefined }): string[] {
  const iso = (row.jurisdictionIso ?? []).filter(isIso);
  if (iso.length > 0) return [...iso];
  const legacy = legacyToIso(row.jurisdiction);
  return legacy ? [legacy] : [];
}

/** The region group ("Europe") of a code, through its legacy slug's label; "" when there is none. */
export function regionGroupOfIso(code: string): string {
  const slug = SLUG_OF_CODE.get(code);
  const label = slug ? JURISDICTIONS.find((j) => j.id === slug)?.label : undefined;
  return label ? regionGroupForLabel(label) : "";
}

/** A row's jurisdiction in words, ONE derivation (the old tree had three): its codes' labels, else its legacy slug's label, else "" (a row that names no jurisdiction is not labelled with one). */
export function jurisLabelOf(r: { jurisdictionIso?: readonly string[] | null | undefined; jurisdiction?: string | null | undefined }): string {
  if (r.jurisdictionIso && r.jurisdictionIso.length > 0) return r.jurisdictionIso.map(isoToDisplayLabel).join(" · ");
  return r.jurisdiction ? (JURISDICTIONS.find((j) => j.id === r.jurisdiction)?.label ?? r.jurisdiction) : "";
}

/** The product label the legacy table gives a code's slug ("EU", "United Kingdom", "Global"), or null when the code has no slug. */
export function legacyLabelOfIso(code: string): string | null {
  const slug = SLUG_OF_CODE.get(code);
  return slug ? (JURISDICTIONS.find((j) => j.id === slug)?.label ?? null) : null;
}
