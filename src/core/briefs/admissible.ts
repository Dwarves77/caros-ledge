// The admissible-row predicate as the brief material needs it: an item is admissible when it is verified and not archived, a FACT claim when its item is and no active suppression covers it.
// R2d (I13) exports THE one predicate every reader applies; until it lands this typed local stub implements the same three conditions behind the interface the material takes, so the swap is one
// import (named in the R2b report's INTERFACE GAPS). Every read is checked: a failed read throws, so a brief is never authored from material filtered by a guess.
import { suppressedClaimMatcher } from "@/core/corrections";
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { readFactSuppressionsFor } from "@/core/detail/claim-tiers";

export interface AdmissibleClaim { id: string; intelligence_item_id: string; claim_text: string | null }
export interface AdmissibleRows {
  /** The members of `ids` that are verified and not archived. */
  itemIds(sb: Db, ids: readonly string[]): Promise<Set<string>>;
  /** The claims of admissible items that no active suppression covers. */
  claims<T extends AdmissibleClaim>(sb: Db, rows: readonly T[]): Promise<T[]>;
}

export const admissibleRows: AdmissibleRows = {
  async itemIds(sb, ids) {
    const rows = await fetchAllByIdChunks<{ id: string }>([...new Set(ids)], async (slice) => {
      const { data, error } = await sb.from("intelligence_items").select("id").in("id", slice).eq("provenance_status", "verified").eq("is_archived", false);
      if (error) throw new Error(`admissible items read failed: ${error.message}`);
      return (data ?? []) as { id: string }[];
    });
    return new Set(rows.map((r) => r.id));
  },
  async claims(sb, rows) {
    const itemIds = [...new Set(rows.map((r) => r.intelligence_item_id))];
    const live = await admissibleRows.itemIds(sb, itemIds);
    const suppressions = await readFactSuppressionsFor(sb, [...live]);
    const matchers = new Map([...live].map((id) => [id, suppressedClaimMatcher(suppressions, id)]));
    return rows.filter((r) => {
      const suppressed = matchers.get(r.intelligence_item_id);
      return !!suppressed && !suppressed({ id: r.id, claim_text: r.claim_text });
    });
  },
};
