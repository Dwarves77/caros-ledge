// The connect stage reads the backlog (IMPACT-1, INV-IMP-1): a verified item that has not been read has its source text extracted and its obligations derived, oldest first, a bounded number per turn; an item read and found to state no duty is recorded
// as read (so the backlog drains); the extractor finds dates and duties in the item's captures, not only in its brief; dry plans the same counts and writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveObligationsJob, extractBackfill, scanBacklog } from "@/features/obligations";

import { C1, C2, C3, capture, DUTY_TEXT, I1, I2, I3, item, NO_DUTY_TEXT, NOW, world } from "./_world.ts";

const deps = (db: ReturnType<typeof world>) => ({ sb: db.client, now: () => NOW });
const run = (db: ReturnType<typeof world>, over: Partial<Parameters<typeof scanBacklog>[1]> = {}) => scanBacklog(deps(db), { dry: false, sliceIds: [], limit: 60, ...over });
const writes = (db: ReturnType<typeof world>) => db.writes().filter((c) => c.op !== "select").map((c) => `${c.op} ${c.table}`);

test("INV-IMP-1: a verified item with a capture that states duties and no obligation objects is read by the next connect stage: its events and its objects are written from the capture, and the reading is recorded", async () => {
  const db = world([item(I1)], [capture(C1, I1, DUTY_TEXT)]);
  const r = await run(db);
  assert.deepEqual([r.outcome, r.counts.scanned, r.counts.backlog, r.counts.failed], ["ok", 1, 1, 0]);
  const objects = db.rows("obligation_objects").filter((o) => o.instrument_item_id === I1).sort((a, b) => String(a.pinpoint_citation).localeCompare(String(b.pinpoint_citation)));
  assert.deepEqual(objects.map((o) => [o.pinpoint_citation, o.duty_holder_class, o.capture_id]), [["Article 5", ["carrier"], C1], ["Article 6", ["shipper"], C1]], "one object per Article pinpoint, each in the capture it was read from; the cross-reference to Article 9 of another instrument names none");
  assert.ok(objects.every((o) => DUTY_TEXT.toLowerCase().includes(String(o.verbatim_text).toLowerCase())), "every object's text is verbatim in the capture");
  const events = db.rows("item_forward_events").filter((e) => e.intelligence_item_id === I1);
  assert.ok(events.length >= 1 && events.every((e) => e.source_kind === "capture" && e.source_capture_id === C1 && e.confidence === "medium"), "the dates come from the capture: the brief held none");
  assert.ok(events.some((e) => e.event_kind === "entry_into_force" && e.event_date === "2027-01-01"));
  assert.deepEqual([r.counts.extracted, r.counts.derived_objects, r.counts.derived_register], [events.length, 2, events.length]);
  const scan = db.rows("item_obligation_scan");
  assert.deepEqual(scan.map((s) => [s.item_id, s.events, s.objects]), [[I1, events.length, 2]]);
  assert.deepEqual(r.data?.ids.scanned_item_ids, [I1]);
});

test("the backlog drains: an item read once is not read again, and an item found to state no duty is recorded as read (the no-duty items never come back every turn)", async () => {
  const db = world([item(I1), item(I2, { instrument_identifier: "Guidance 2026/2" })], [capture(C1, I1, DUTY_TEXT), capture(C2, I2, NO_DUTY_TEXT)]);
  const first = await run(db);
  assert.deepEqual([first.counts.scanned, first.counts.skipped_no_duty, first.counts.derived_objects], [2, 1, 2], "the second item states no duty: read, nothing derived, counted");
  assert.equal(db.rows("obligation_objects").filter((o) => o.instrument_item_id === I2).length, 0);
  const second = await run(db);
  assert.deepEqual([second.counts.backlog, second.counts.scanned, second.counts.extracted], [0, 0, 0], "nothing is left to read");
  assert.deepEqual(writes(db).filter((w) => w.endsWith("item_obligation_scan")).length, 1, "the second turn wrote no reading");
});

test("bounded and oldest first: at most `limit` backlog items are read per turn, the oldest brief first, and the rest follow on the next turn", async () => {
  const db = world(
    [item(I1, { last_regenerated_at: "2026-03-01T00:00:00.000Z" }), item(I2, { last_regenerated_at: "2025-01-01T00:00:00.000Z" }), item(I3, { last_regenerated_at: "2026-02-01T00:00:00.000Z" })],
    [capture(C1, I1, DUTY_TEXT), capture(C2, I2, NO_DUTY_TEXT), capture(C3, I3, NO_DUTY_TEXT)],
  );
  const a = await run(db, { limit: 2 });
  assert.deepEqual([a.counts.scanned, a.counts.backlog, a.counts.backlog_left], [2, 3, 1]);
  assert.deepEqual(a.data?.ids.scanned_item_ids.sort(), [I2, I3].sort(), "the two oldest briefs");
  const b = await run(db, { limit: 2 });
  assert.deepEqual([b.counts.scanned, b.counts.backlog_left, b.data?.ids.scanned_item_ids], [1, 0, [I1]]);
});

test("a brief regenerated after the last reading, or a new extractor version, puts the item back in the backlog; the slice the stage connected is always read", async () => {
  const db = world([item(I1)], [capture(C1, I1, NO_DUTY_TEXT)]);
  await run(db);
  assert.equal((await run(db)).counts.backlog, 0);
  db.rows("intelligence_items")[0]!.last_regenerated_at = "2026-10-16T00:00:00.000Z";
  assert.equal((await run(db)).counts.scanned, 1, "regenerated after it was read");
  db.rows("item_obligation_scan")[0]!.extractor_version = "an-older-extractor";
  assert.equal((await run(db)).counts.scanned, 1, "read at another extractor version");
  assert.equal((await run(db, { sliceIds: [I1] })).counts.scanned, 1, "an item just connected is read whether or not it was");
});

test("dry plans the same counts as apply and writes nothing", async () => {
  const dryDb = world([item(I1)], [capture(C1, I1, DUTY_TEXT)]);
  const dry = await run(dryDb, { dry: true });
  assert.deepEqual(writes(dryDb), [], "a dry reading writes nothing");
  const applied = await run(world([item(I1)], [capture(C1, I1, DUTY_TEXT)]));
  for (const k of ["scanned", "extracted", "derived", "derived_objects", "derived_register", "refused", "skipped_no_duty", "backlog"]) assert.equal(dry.counts[k], applied.counts[k], `planned ${k} equals applied`);
});

test("a duty whose binding position cannot be decided is refused with its reason, counted and grouped; the item is still recorded as read", async () => {
  const text = `${["Article 3 Obligations", "1. Forwarders shall keep the consignment records for five years."].join("\n")}\n${"Notice. This text is provided for information only and is not the authentic version. ".repeat(4)}`;
  const db = world([item(I1, { title: "A plain notice", instrument_identifier: null })], [capture(C1, I1, text)]);
  const r = await run(db);
  assert.deepEqual([r.counts.derived_objects, r.counts.refused, r.counts.refused_binding_position_unresolved, r.counts.scanned], [0, 1, 1, 1]);
});

test("an item whose source cannot be read is not recorded as read and is counted failed; the others are read", async () => {
  const db = world([item(I1), item(I2)], [capture(C1, I1, DUTY_TEXT), capture(C2, I2, DUTY_TEXT)]);
  db.fail("agent_run_searches", "select", "read error", { when: (c) => c.filters.some(([, , v]) => v === I1) });
  const r = await run(db);
  assert.deepEqual([r.outcome, r.counts.failed, r.counts.scanned], ["partial", 1, 1]);
  assert.deepEqual(db.rows("item_obligation_scan").map((s) => s.item_id), [I2], "the failed item will be read again next turn");
});

test("the operator's replay (the derive-obligations op) derives every verified live item in batches, sums the counts, and a second replay registers nothing new", async () => {
  const ids = Array.from({ length: 45 }, (_, n) => `33333333-0000-4000-8000-${String(n + 1).padStart(12, "0")}`);
  const db = world(ids.map((id) => item(id)), ids.map((id, n) => capture(`44444444-0000-4000-8000-${String(n + 1).padStart(12, "0")}`, id, DUTY_TEXT)));
  db.seed("intelligence_items", [item("33333333-0000-4000-8000-0000000000ff", { is_archived: true })]);
  const first = await deriveObligationsJob({ sb: db.client }, { dry: false });
  assert.deepEqual([first.outcome, first.counts.objects_inserted, db.rows("obligation_objects").length], ["ok", 90, 90], "45 items in three batches, two duties each; the archived item is not read");
  const again = await deriveObligationsJob({ sb: db.client }, { dry: false });
  assert.deepEqual([again.counts.objects_inserted, again.counts.objects_already_registered, db.rows("obligation_objects").length], [0, 90, 90]);
});

test("the extract-backfill op, the instrument that sized the backlog, plans the events the captures hold (dry writes nothing) and an apply covers the item", async () => {
  const db = world([item(I1)], [capture(C1, I1, DUTY_TEXT)]);
  const dry = await extractBackfill({ sb: db.client, now: () => NOW }, { dry: true });
  assert.deepEqual([dry.counts.scope, dry.counts.items_with_events, dry.counts.events, dry.counts.inserted, db.rows("item_forward_events").length], [1, 1, 1, 0, 0]);
  const applied = await extractBackfill({ sb: db.client, now: () => NOW }, { dry: false });
  assert.deepEqual([applied.counts.inserted, db.rows("item_forward_events").map((e) => e.source_kind)], [1, ["capture"]]);
  assert.equal((await extractBackfill({ sb: db.client, now: () => NOW }, { dry: false })).counts.scope, 0, "an item that holds an event is out of the backfill's scope");
});
