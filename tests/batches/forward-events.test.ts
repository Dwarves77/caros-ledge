import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { applyBatch } from "@/features/batches";
import { forwardEventsExporter } from "@/features/batches/kinds/forward-events/export";
import { applyLimit, buildSnapshot, partitionByCorpusMembership } from "@/features/batches/kinds/forward-events/tickets";
import { forwardEventKey } from "@/features/obligations";

import { batchFile, ITEM, NOW, SPAN_FORCE } from "./world.ts";
import { ARCHIVED, CLAIM, feWorld, SECTION, T, UNVERIFIED, type World } from "./worlds.ts";

const event = (over: Record<string, unknown> = {}) => ({ event_date: "2027-01-01", date_precision: "day", event_kind: "entry_into_force", obligation_text: "The Regulation enters into force on 1 January 2027.", source_kind: "claim", source_claim_id: CLAIM, source_section_id: null, source_span: SPAN_FORCE, confidence: "high", extractor_version: "fe-test-1", ...over });
const entry = (over: Record<string, unknown> = {}) => ({ item_id: ITEM, ticket_ids: [T.open], events: [event()], ...over });
const apply = (w: World, entries: unknown[], dry = false, file: Record<string, unknown> = {}) => applyBatch("forward-events", w.deps, { content: JSON.stringify(batchFile("forward-events", entries, file)), dry });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const ticket = (w: World, id: string) => w.db.rows("corpus_turn_requests").find((r) => r.id === id) as Record<string, unknown>;

test("INV-212 selection: the open queue is partitioned by the item's live state before any limit; only the selectable items go out, with the ticket ids they serve and the snapshot a mark would retire", async () => {
  const w = feWorld();
  const r = await forwardEventsExporter(w.db.client, () => NOW)({ limit: 5 });
  assert.equal(r.ok, true, r.error);
  const items = r.items as unknown as { id: string; ticket_ids: string[]; claims: unknown[] }[];
  assert.deepEqual(items.find((i) => i.id === ITEM)?.ticket_ids, [T.open]);
  assert.equal(items.some((i) => i.id === ARCHIVED || i.id === UNVERIFIED), false);
  const snap = (r.summary as { tickets: { ids: string[]; archived_requests: { id: string }[]; deferred_not_verified: number } }).tickets;
  assert.deepEqual([snap.ids, snap.archived_requests.map((a) => a.id), snap.deferred_not_verified], [[ITEM], [T.archived], 1]);
  assert.deepEqual(partitionByCorpusMembership([{ id: "x", intelligence_item_id: "gone", reason: null, requested_at: "" }], new Map()).deferred.length, 1, "an item that vanished defers; its ticket is not consumed");
  assert.deepEqual(applyLimit([1, 2, 3], 2), [1, 2]);
  assert.equal(buildSnapshot([], { generatedAt: "t" }).count, 0);
});

test("events load through the ONE writer on the migration-307 key, derive the item's obligations and consume exactly the ticket the entry names; a re-apply writes nothing new", async () => {
  const w = feWorld();
  const r = await apply(w, [entry()]);
  assert.equal(r.counts.applied, 1, notes(r));
  assert.equal(r.counts.events_inserted, 1);
  const rows = w.db.rows("item_forward_events");
  assert.equal(rows.length, 1);
  assert.equal(forwardEventKey(rows[0] as never), forwardEventKey(event() as never), "the stored row has the shared key");
  assert.ok(w.rec.connects.includes(`obligations:${ITEM}`), "the obligations were derived in the same run");
  assert.deepEqual([ticket(w, T.open).consumed_by, ticket(w, T.deferred).consumed_at, ticket(w, T.archived).consumed_at], ["forward-events-001", null, null]);
  const writes = w.db.writes().length;
  const again = await apply(w, [entry({ ticket_ids: [] })]);
  assert.deepEqual([again.counts.already_applied, again.counts.applied], [1, 0]);
  assert.equal(w.db.writes().length, writes);
});

test("the forward-event key is shared: an event whose date, kind and text are already held is not inserted again, and a different text is; the kit has no second key", async () => {
  const w = feWorld();
  w.db.seed("item_forward_events", [{ intelligence_item_id: ITEM, ...event(), obligation_text: "The Regulation enters into force on 1 January 2027." }]);
  const same = await apply(w, [entry({ ticket_ids: [], events: [event(), event({ obligation_text: "Operators must report from that date." })] })]);
  assert.equal(same.counts.events_inserted, 1, notes(same));
  assert.equal(w.db.rows("item_forward_events").length, 2);
  const dir = new URL("../../src/features/batches/kinds/forward-events/", import.meta.url);
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /createHash|md5/, `${f} builds no key of its own`);
  assert.match(readFileSync(new URL("apply.ts", dir), "utf8"), /forwardEventKey, insertForwardEvents/);
});

test("INV-212 attack: a ticket of an unverified item stays open and its entry is refused; a ticket of another item, a consumed ticket and an archived item are refused; nothing is consumed", async () => {
  const w = feWorld();
  w.db.seed("section_claim_provenance", [{ id: "c1000000-0000-4000-8000-000000000002", intelligence_item_id: UNVERIFIED, claim_kind: "FACT", claim_text: SPAN_FORCE, source_span: SPAN_FORCE }]);
  const un = entry({ item_id: UNVERIFIED, ticket_ids: [T.deferred], events: [event({ source_claim_id: "c1000000-0000-4000-8000-000000000002" })] });
  const r = await apply(w, [un, entry({ ticket_ids: [T.archived] }), entry({ item_id: ARCHIVED, ticket_ids: [] })]);
  assert.equal(r.counts.applied ?? 0, 0);
  assert.match(notes(r), /the item is not verified and live, so the ticket stays open/);
  assert.match(notes(r), /belongs to another item/);
  assert.match(notes(r), /the item is archived: its events are not loaded/);
  for (const id of Object.values(T)) assert.equal(ticket(w, id).consumed_at, null, `ticket ${id} stays open`);
  assert.equal(w.db.rows("item_forward_events").length, 0);
  await apply(w, [entry()]);
  const reuse = await apply(w, [entry({ events: [event({ event_date: "2028-01-01" })] })]);
  assert.match(notes(reuse), /is not an open ticket/, "a consumed ticket cannot serve a second run");
});

test("INV-212: the tickets of archived items close under `<batch>:item-archived` and only when the item really is archived", async () => {
  const w = feWorld();
  const r = await apply(w, [entry()], false, { archived_ticket_ids: [T.archived, T.open, T.deferred] });
  assert.equal(r.counts.downstream_archived_tickets_closed, 1, notes(r));
  assert.equal(ticket(w, T.archived).consumed_by, "forward-events-001:item-archived");
  assert.equal(ticket(w, T.deferred).consumed_at, null, "a ticket of an item that is not archived is not closed under the archived label");
  assert.match(notes(r), /its item is not archived, so the ticket stays open/);
});

test("the database's own CHECKs are mirrored before any write: kind, precision, date, confidence, claim-or-section source, the span verbatim in what it cites", async () => {
  const w = feWorld();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["kind", { event_kind: "party" }, /event_kind "party" is not one of/],
    ["precision", { date_precision: "week" }, /date_precision "week" is not one of/],
    ["date", { event_date: "1 Jan 2027" }, /event_date must be an ISO date/],
    ["confidence", { confidence: "certain" }, /confidence must be high or medium/],
    ["high from a section", { source_kind: "section", source_claim_id: null, source_section_id: SECTION }, /high confidence needs a claim source/],
    ["claim kind without a claim id", { source_claim_id: null }, /a claim-sourced event names source_claim_id/],
    ["a claim of another item", { source_claim_id: "c1000000-0000-4000-8000-0000000000ff" }, /is not a claim of this item/],
    ["a span the claim does not hold", { source_span: "Operators are exempt from every duty under this Regulation." }, /source_span is not verbatim in the claim it cites/],
    ["missing text", { obligation_text: "" }, /obligation_text missing/],
  ];
  for (const [name, over, re] of cases) assert.match(notes(await apply(w, [entry({ events: [event(over)], ticket_ids: [] })])), re, name);
  assert.equal(w.db.rows("item_forward_events").length, 0);
  const section = await apply(w, [entry({ ticket_ids: [], events: [event({ source_kind: "section", source_claim_id: null, source_section_id: SECTION, confidence: "medium" })] })]);
  assert.equal(section.counts.applied, 1, notes(section));
  assert.match(notes(await apply(w, [entry({ ticket_ids: [], events: [] })])), /events must be a non-empty array/);
});
