// The ONE admissible-row predicate (I13). A row a customer reader may use is verified, not archived, not suppressed and current (nothing supersedes it). Every reader of the item, claim,
// factor and inference tables takes this definition, as a filter on its query (`admitItems`, `admitFactors`) or as a test on rows it already holds (`isAdmissibleItem`, `isAdmissibleClaim`,
// `isCurrentInference`); the SQL view `derived_values_admissible` (migration 0090) carries the same rule for derived values. tests/derived/readers.test.ts lists every file that reads these
// tables and fails when a customer reader does not import this module.
import { suppressedClaimMatcher, type ClaimRef, type Correction } from "@/core/corrections";
import type { Qb } from "@/core/db/qb";

/** The columns an item row needs for the test: read them, or the row is not admissible (an absent column is not a pass). */
export const ITEM_ADMISSIBLE_COLUMNS = "provenance_status, is_archived, replaced_by";

export interface ItemAdmissibility {
  provenance_status?: string | null | undefined;
  is_archived?: boolean | null | undefined;
  replaced_by?: string | null | undefined;
}
/** Verified, not archived, and not replaced by another item. */
export function isAdmissibleItem(row: ItemAdmissibility | null | undefined): boolean {
  return !!row && row.provenance_status === "verified" && row.is_archived === false && row.replaced_by === null;
}

/**
 * The same rule as a filter. `embed` names an embedded relation (`item` for `item:intelligence_items!inner(id)`), so a reader that joins items through another table applies it on the join.
 * The result is the query: awaited, it fails with the database's error like any read.
 */
export function admitItems<Q>(query: Q, embed?: string): Q {
  const at = (column: string): string => (embed ? `${embed}.${column}` : column);
  return (query as unknown as Qb).eq(at("provenance_status"), "verified").eq(at("is_archived"), false).is(at("replaced_by"), null) as unknown as Q;
}

/** An emission factor is current while no factor supersedes it; a superseded one is history. */
export const isAdmissibleFactor = (row: { superseded_by?: string | null | undefined } | null | undefined): boolean => !!row && row.superseded_by === null;
export const admitFactors = <Q>(query: Q): Q => (query as unknown as Qb).is("superseded_by", null) as unknown as Q;

/** A claim is admissible unless an admin suppressed it: `isSuppressed` is core/corrections' suppressedClaimMatcher for the claim's item, and a failed suppression read must never reach here as an empty matcher. */
export const isAdmissibleClaim = (claim: ClaimRef | null | undefined, isSuppressed: (claim: ClaimRef) => boolean): boolean => !!claim && !isSuppressed(claim);

/** The claims of any number of items that no active suppression takes out, given the suppressions of those items (every item the claims belong to must be covered by the suppressions read: a failed read throws before this). */
export function admissibleClaims<T extends { id?: string | number | null; claim_text?: string | null; intelligence_item_id: string }>(claims: readonly T[], suppressions: readonly Correction[]): T[] {
  const matchers = new Map<string, (claim: ClaimRef) => boolean>();
  const matcherOf = (itemId: string) => matchers.get(itemId) ?? (matchers.set(itemId, suppressedClaimMatcher(suppressions, itemId)), matchers.get(itemId) as (claim: ClaimRef) => boolean);
  return claims.filter((c) => isAdmissibleClaim(c as ClaimRef, matcherOf(c.intelligence_item_id)));
}

/** An inference is current while it is admissible and no inference supersedes it (`supersededIds` is every `supersedes` value among the rows read). */
export const isCurrentInference = (row: { inference_id: string; admissibility?: string | null | undefined }, supersededIds: ReadonlySet<string>): boolean => row.admissibility === "current" && !supersededIds.has(row.inference_id);
