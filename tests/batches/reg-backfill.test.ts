// REG-BACKFILL-1. INV-RB-1: the selector returns only verified, unarchived, unreplaced regulations with an empty field and a usable pool, impact first; an empty-pool item is a heal candidate.
import assert from "node:assert/strict";
import { test } from "node:test";

import { regulationBackfillCandidates } from "@/features/batches/kinds/item-briefs/candidates";

import { MemDb } from "../_support/memdb.ts";

const id = (n: number): string => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEXT = "The regulation sets binding limits on greenhouse gas intensity for fuel used by ships calling at EU ports. ".repeat(4);
const item = (n: number, over: Record<string, unknown> = {}) => ({ id: id(n), item_type: "regulation", provenance_status: "verified", is_archived: false, replaced_by: null, what_is_it: "", why_matters: "It matters.", what_it_changes: "It changes.", ...over });
const cap = (n: number) => ({ intelligence_item_id: id(n), result_url: `https://eur-lex.europa.eu/${n}`, result_content: TEXT, result_index: 0 });
const score = (n: number, cost: number) => ({ item_id: id(n), cost, compliance: 0, operational: 0, missing: [] });

function world() {
  const db = new MemDb();
  db.seed("intelligence_items", [
    item(1), item(2, { what_is_it: null, why_matters: "", what_it_changes: "" }), item(3, { what_it_changes: "" }), item(4),
    item(5, { what_is_it: "Full.", why_matters: "Full.", what_it_changes: "Full." }), item(6, { provenance_status: "quarantined" }), item(7, { is_archived: true }), item(8, { replaced_by: id(1) }), item(9, { item_type: "market_signal" }),
  ]);
  db.seed("agent_run_searches", [cap(1), cap(2), cap(3), { ...cap(4), result_content: "short" }, cap(5), cap(6), cap(7), cap(8), cap(9)]);
  db.seed("item_impact_scores", [score(1, 1), score(2, 3), score(3, 2)]);
  return db;
}

test("INV-RB-1: only verified, unarchived, unreplaced regulations with an empty field and a usable pool, highest impact first; an empty pool is a heal candidate", async () => {
  const page = await regulationBackfillCandidates(world() as never, { limit: 10 });
  assert.deepEqual(page.candidates.map((c) => c.id), [id(2), id(3), id(1)]);
  assert.deepEqual(page.heal_candidates, [id(4)]);
  assert.deepEqual(page.backlog, { total: 4, all_three_empty: 1, partial: 3 });
  assert.equal(page.next, null);
});

test("INV-RB-1: limit and cursor page through the backlog without repeating or skipping", async () => {
  const db = world() as never;
  const first = await regulationBackfillCandidates(db, { limit: 2 });
  assert.deepEqual(first.candidates.map((c) => c.id), [id(2), id(3)]);
  assert.equal(first.next, id(3));
  const rest = await regulationBackfillCandidates(db, { limit: 2, cursor: first.next });
  assert.deepEqual(rest.candidates.map((c) => c.id), [id(1)]);
  assert.deepEqual(rest.heal_candidates, [id(4)]);
  await assert.rejects(regulationBackfillCandidates(db, { limit: 2, cursor: id(99) }), /not in the backlog/);
});
