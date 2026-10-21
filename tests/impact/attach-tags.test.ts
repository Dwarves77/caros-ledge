// INV-LS-4: an item whose tag columns the caller already holds is not read again for its client score.
import assert from "node:assert/strict";
import { test } from "node:test";

import { attachImpact } from "@/core/impact/attach";
import type { Resource } from "@/core/types";

import { I1, I2, item, world } from "./_world.ts";

const O1 = "00000000-0000-4000-8000-0000000000a1";
const score = (item_id: string) => ({ item_id, cost: 1, compliance: 2, operational: 3, basis: {}, missing: [], method_version: "impact_scores@1.0.0", computed_at: "2026-10-15T12:00:00.000Z" });
const made = () =>
  world([item(I1, { transport_modes: ["ocean"] }), item(I2, { transport_modes: ["ocean"] })], [], {
    item_impact_scores: [score(I1), score(I2)],
    workspace_settings: [{ org_id: O1, sector_profile: [], jurisdiction_weights: { EU: 1 }, profile: { transport_modes: ["ocean"], roles: [] } }],
  });
const rows = (): Resource[] => [{ id: "a" }, { id: "b" }] as Resource[];
const uuids = new Map([["a", I1], ["b", I2]]);
const held = (id: string) => [id, { id, title: `Instrument ${id.slice(-1)}`, transport_modes: ["ocean"], jurisdictions: [], jurisdiction_iso: ["EU"], topic_tags: [], operational_scenario_tags: [], compliance_object_tags: [] }] as const;

test("INV-LS-4: with every item's tag columns held, attachImpact reads no intelligence_items and the scores are the ones the table read gives; with one held, it reads only the other", async () => {
  const read = made();
  const fromTable = rows();
  await attachImpact(read.client, fromTable, uuids, O1);
  assert.equal(read.reads("intelligence_items").length, 1, "without a map the tag columns are read");

  const all = made();
  const withMap = rows();
  await attachImpact(all.client, withMap, uuids, O1, undefined, new Map([held(I1), held(I2)]));
  assert.equal(all.reads("intelligence_items").length, 0, "nothing is read for items the caller holds");
  assert.deepEqual(withMap.map((r) => r.impactScores), fromTable.map((r) => r.impactScores), "the same scores");
  assert.deepEqual(withMap[0]?.impactScores, { cost: 1, compliance: 2, client: 2, operational: 3 });

  const some = made();
  const partial = rows();
  await attachImpact(some.client, partial, uuids, O1, undefined, new Map([held(I1)]));
  const reads = some.reads("intelligence_items");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]?.filters.find(([op]) => op === "in")?.[2], [I2], "only the item not held is read");
  assert.deepEqual(partial.map((r) => r.impactScores), fromTable.map((r) => r.impactScores));
});
