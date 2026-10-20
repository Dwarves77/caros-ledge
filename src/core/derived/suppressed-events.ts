// The forward events an admin took out by suppressing the claim they were read from (I13, register flywheel:21). A reader applies the answer in its query (`not id in`), so the count, the page and the rail agree.
// The suppressions are the member-readable `fact_suppressions` view; a claim is matched by id or by its machine text through core/corrections' matcher, the one definition. A failed read throws: an event is never shown because
// the suppressions could not be read.
import { suppressedClaimMatcher, type Correction } from "@/core/corrections";
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";

const COLUMNS = "id, item_id, target_kind, target_ref, op, machine_value, created_at, revoked_at";

/** `itemId` narrows the read to one item's suppressions (a per-item caller); none reads them all (a reader of the whole register). */
export async function suppressedEventIds(sb: Db, itemId?: string): Promise<string[]> {
  const rows = await fetchAllRows<Correction>((from, to) => {
    const q = sb.from("fact_suppressions").select(COLUMNS);
    return (itemId ? q.eq("item_id", itemId) : q).order("id", { ascending: true }).range(from, to) as never;
  }, { cap: 20_000 });
  if (!rows.length) return [];
  const itemIds = [...new Set(rows.map((r) => r.item_id))];
  const claims = await fetchAllByIdChunks<{ id: string; claim_text: string; intelligence_item_id: string }>(
    itemIds,
    (slice) => fetchAllRows((from, to) => sb.from("section_claim_provenance").select("id, claim_text, intelligence_item_id").in("intelligence_item_id", slice).order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 }),
    { chunk: 10, manyPerId: true },
  );
  const matchers = new Map(itemIds.map((id) => [id, suppressedClaimMatcher(rows, id)]));
  const claimIds = claims.filter((c) => matchers.get(c.intelligence_item_id)?.(c) === true).map((c) => c.id);
  const events = await fetchAllByIdChunks<{ id: string }>(
    claimIds,
    async (slice) => {
      const { data, error } = await sb.from("item_forward_events").select("id").in("source_claim_id", slice);
      if (error) throw new Error(`item_forward_events read failed: ${error.message}`);
      return (data ?? []) as { id: string }[];
    },
    { manyPerId: true },
  );
  return events.map((e) => e.id);
}

/** The `not id in (...)` list a PostgREST filter takes; null when nothing is suppressed (no filter at all). */
export const notInList = (ids: readonly string[]): string | null => (ids.length ? `(${ids.join(",")})` : null);
