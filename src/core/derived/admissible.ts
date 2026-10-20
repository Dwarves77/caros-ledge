// The ONE admissible-row predicate (I13). A row a customer reader may use is verified, not archived, not suppressed and current (nothing supersedes it). Every reader of the item, claim,
// factor and inference tables takes this definition: `admissibleRows` (`.itemIds`, `.claims`) for a reader that holds ids or claim rows and asks which stand, a filter on its own query
// (`admitItems`, `admitFactors`), or a test on a row it already holds (`isAdmissibleItem`, `admissibleClaims`, `isCurrentInference`). The SQL carries the same rule: `item_is_admissible` (0092),
// the view `admissible_claims` (0093) and `derived_values_admissible` (0090). tests/derived/readers.test.ts lists every file that reads these tables and fails when a customer reader does not import this module.
import { suppressedClaimMatcher, type ClaimRef, type Correction } from "@/core/corrections";
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import type { Qb } from "@/core/db/qb";
import { readFactSuppressionsFor } from "@/core/detail/claim-tiers";

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

/** The claims of any number of items that no active suppression takes out, given the suppressions of those items (every item the claims belong to must be covered by the suppressions read: a failed read throws before this). */
export function admissibleClaims<T extends { id?: string | number | null; claim_text?: string | null; intelligence_item_id: string }>(claims: readonly T[], suppressions: readonly Correction[]): T[] {
  const matchers = new Map<string, (claim: ClaimRef) => boolean>();
  const matcherOf = (itemId: string) => matchers.get(itemId) ?? (matchers.set(itemId, suppressedClaimMatcher(suppressions, itemId)), matchers.get(itemId) as (claim: ClaimRef) => boolean);
  return claims.filter((c) => !matcherOf(c.intelligence_item_id)(c as ClaimRef));
}

/** An inference is current while it is admissible and no inference supersedes it (`supersededIds` is every `supersedes` value among the rows read). */
export const isCurrentInference = (row: { inference_id: string; admissibility?: string | null | undefined }, supersededIds: ReadonlySet<string>): boolean => row.admissibility === "current" && !supersededIds.has(row.inference_id);

export type AdmissibleRows = typeof admissibleRows;
export interface AdmissibleClaimRow {
  id: string;
  intelligence_item_id: string;
  claim_text: string | null;
}
/** The reading form of the predicate. Every read is checked: a failed one throws, so a caller never filters by a guess. */
export const admissibleRows = {
  /** The members of `ids` that are admissible items. */
  async itemIds(db: Db, ids: readonly string[]): Promise<Set<string>> {
    const rows = await fetchAllByIdChunks<{ id: string }>([...new Set(ids)], async (slice) => {
      const { data, error } = await admitItems(db.from("intelligence_items").select("id")).in("id", slice);
      if (error) throw new Error(`admissible items read failed: ${error.message}`);
      return (data ?? []) as { id: string }[];
    });
    return new Set(rows.map((r) => r.id));
  },
  /** The claims of admissible items that no active suppression covers. */
  async claims<T extends AdmissibleClaimRow>(db: Db, rows: readonly T[]): Promise<T[]> {
    const live = await admissibleRows.itemIds(db, rows.map((r) => r.intelligence_item_id));
    return admissibleClaims(rows.filter((r) => live.has(r.intelligence_item_id)), await readFactSuppressionsFor(db, [...live]));
  },
};
