// The propagate stage's scoring step (IMPACT-1, I3): every verified item whose inputs changed since its score was computed (and every item on the first run) is scored by the registered method and stored; an unchanged item is not scored again; a
// turn scores a bounded number; a NULL dimension names the input it waits for; dry plans the same counts and writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreItems } from "@/core/impact/run";
import { createMethodRegistry } from "@/core/propagation";
import { scanBacklog } from "@/features/obligations";

import { C1, C2, capture, DUTY_TEXT, I1, I2, I3, item, NOW, world } from "./_world.ts";

const registry = createMethodRegistry();
const score = (db: ReturnType<typeof world>, over: Partial<Parameters<typeof scoreItems>[1]> = {}, now = NOW) => scoreItems({ sb: db.client, now: () => now, registry }, { dry: false, readIds: [], ...over });
const LATER = new Date("2026-10-20T12:00:00.000Z");
const stored = (db: ReturnType<typeof world>) => Object.fromEntries(db.rows("item_impact_scores").map((r) => [r.item_id, r]));
const made = () => {
  const db = world([item(I1), item(I2, { cost_mechanism: "A per-unit penalty", last_regenerated_at: "2026-02-01T00:00:00.000Z" })], [capture(C1, I1, DUTY_TEXT), capture(C2, I2, DUTY_TEXT)]);
  return db;
};

test("a read item is scored from what it holds, an unread one from what it holds with the unread inputs NULL and named; the basis names the obligations", async () => {
  const db = made();
  await scanBacklog({ sb: db.client, now: () => NOW }, { dry: false, sliceIds: [I1], limit: 0 });
  const r = await score(db);
  assert.deepEqual([r.outcome, r.counts.impact_scored, r.counts.impact_backlog], ["ok", 2, 2]);
  const rows = stored(db);
  const objects = db.rows("obligation_objects").filter((o) => o.instrument_item_id === I1).map((o) => String(o.obligation_id)).sort();
  assert.deepEqual([rows[I1]?.compliance, rows[I1]?.cost, rows[I1]?.operational, rows[I1]?.missing], [1, 0, 3, []], "duties on carriers and shippers that do not reach the forwarder: non-binding, no cost signal, a carrier duty");
  assert.deepEqual(((rows[I1]?.basis as { compliance: { obligations: string[] } }).compliance.obligations).sort(), objects);
  assert.deepEqual([rows[I2]?.compliance, rows[I2]?.cost, rows[I2]?.operational, rows[I2]?.missing], [null, 1, null, ["obligations", "operational"]], "the second item was never read: its mechanism scores, its other inputs are named");
  assert.equal(rows[I1]?.method_version, "impact_scores@1.0.0");
  assert.deepEqual([r.counts.impact_missing_obligations, r.counts.impact_missing_operational, r.counts.impact_missing_cost], [1, 1, 0]);
});

test("an item whose inputs have not changed is not scored again; a changed item, a newly read item and a score of another method version are", async () => {
  const db = made();
  await scanBacklog({ sb: db.client, now: () => NOW }, { dry: false, sliceIds: [I1, I2], limit: 0 });
  assert.equal((await score(db)).counts.impact_scored, 2);
  const again = await score(db);
  assert.deepEqual([again.counts.impact_scored, again.counts.impact_backlog], [0, 0]);
  db.rows("intelligence_items").find((i) => i.id === I1)!.updated_at = "2026-10-16T00:00:00.000Z";
  assert.deepEqual((await score(db, {}, LATER)).data?.ids.scored_item_ids, [I1], "the item changed after its score");
  db.rows("item_obligation_scan").find((s) => s.item_id === I2)!.scanned_at = "2026-10-21T00:00:00.000Z";
  assert.deepEqual((await score(db, {}, new Date("2026-10-22T00:00:00.000Z"))).data?.ids.scored_item_ids, [I2], "the item was read again after its score");
  db.rows("item_impact_scores").find((s) => s.item_id === I1)!.method_version = "impact_scores@0.9.0";
  assert.deepEqual((await score(db, {}, new Date("2026-10-23T00:00:00.000Z"))).data?.ids.scored_item_ids, [I1], "scored by another version of the method");
});

test("a turn scores at most its bound, the items the connect stage just read first, the rest on the next turn", async () => {
  const db = world([item(I1), item(I2), item(I3)], []);
  const first = await score(db, { limit: 1, readIds: [I3] });
  assert.deepEqual([first.data?.ids.scored_item_ids.sort(), first.counts.impact_backlog, first.counts.impact_backlog_left], [[I1, I3], 2, 1], "the read item, then one of the backlog");
  const second = await score(db, { limit: 1 });
  assert.deepEqual([second.data?.ids.scored_item_ids, second.counts.impact_backlog_left], [[I2], 0]);
});

test("dry scores the same items with the same counts and writes nothing", async () => {
  const dry = made();
  const d = await score(dry, { dry: true });
  assert.deepEqual(dry.writes().filter((c) => c.op !== "select"), []);
  const applied = await score(made());
  assert.deepEqual(d.counts, applied.counts);
});

test("a failed input read fails the step and writes no score", async () => {
  const db = made();
  db.fail("obligation_objects", "select", "read error");
  await assert.rejects(() => score(db), /obligation_objects read failed/);
  assert.equal(db.rows("item_impact_scores").length, 0);
});
