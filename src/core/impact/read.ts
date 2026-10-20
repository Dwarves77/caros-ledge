// New file (scripts/ci/new-files/impact-1.txt): what a list row draws from the stored scores. The three stored dimensions come from item_impact_scores, the fourth (client) from the reading workspace's relevance to the item, computed here at read time and never
// stored. A row whose score row is absent, or whose dimension is NULL, or that has no workspace to read against, has no ImpactScores at all: it carries the sentence of the first input it is waiting for, and the page draws the dash (a NULL is never a 0).
import { fetchAllByIdChunks, isMissingObject, type Db } from "@/core/db";
import type { ImpactScores } from "@/core/types";
import type { ItemRelevance } from "@/core/workspace";

import { firstMissing, READING } from "./rules";

export interface StoredImpact {
  item_id: string;
  cost: number | null;
  compliance: number | null;
  operational: number | null;
  missing: string[];
}
const COLUMNS = "item_id, cost, compliance, operational, missing";

/** The stored scores of these items, one read per 150 ids. A failed read throws: a row is never drawn from a partial answer. The table not being there yet (the migration is pending) is no score rows, which a row names as the first reading it waits for. */
export async function readImpactRows(db: Db, itemIds: readonly string[]): Promise<Map<string, StoredImpact>> {
  const rows = await fetchAllByIdChunks<StoredImpact>(itemIds, async (slice) => {
    const { data, error } = await db.from("item_impact_scores").select(COLUMNS).in("item_id", slice);
    if (error && isMissingObject(error)) return [];
    if (error) throw new Error(`item_impact_scores read failed: ${error.message}`);
    return (data ?? []) as StoredImpact[];
  }, { chunk: 150 });
  return new Map(rows.map((r) => [r.item_id, r]));
}

/** The workspace's client dimension for an item: 0 when the item does not apply to the workspace, else its relevance band as 1 to 3. */
export const clientScore = (relevance: Pick<ItemRelevance, "band" | "applicability">): number => (relevance.applicability?.status === READING.client.noRelevanceStatus ? 0 : READING.client.bands[relevance.band]);

/** The row's impact: all four dimensions, or the sentence naming the first input still missing (an item with no score row is waiting for its first reading). */
export function composeImpact(stored: StoredImpact | undefined, client: number | null): { scores: ImpactScores | null; absence: string | null } {
  const missing = stored ? firstMissing(stored.missing) : "obligations";
  if (missing) return { scores: null, absence: READING.absence[missing] };
  if (!stored || client === null || stored.cost === null || stored.compliance === null || stored.operational === null) return { scores: null, absence: READING.absence.client };
  return { scores: { cost: stored.cost, compliance: stored.compliance, client, operational: stored.operational }, absence: null };
}
