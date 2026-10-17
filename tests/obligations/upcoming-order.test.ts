import assert from "node:assert/strict";
import { test } from "node:test";

import { readUpcoming } from "@/features/obligations";

import { MemDb } from "../_support/memdb.ts";

const A = "0a000000-0000-4000-8000-00000000000a";
const B = "0b000000-0000-4000-8000-00000000000b";
const ITEM = "10000000-0000-4000-8000-000000000001";
const ev = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id, intelligence_item_id: ITEM, event_date: "2026-12-31", date_precision: "day", event_kind: "compliance_deadline", obligation_text: `text ${id}`, source_kind: "section", confidence: "medium", created_at: createdAt, ...over });

test("the upcoming rail's order: by date, and on one date by the order the events were recorded (the old read had no second key, so the rows came back in insertion order), never by a random id", async () => {
  const db = new MemDb({}, {});
  db.seed("intelligence_items", [{ id: ITEM, title: "Item", legacy_id: "i1", provenance_status: "verified", is_archived: false, jurisdiction_iso: ["EU"], transport_modes: ["road"] }]);
  // Two events on one date whose ids sort the opposite way from the order they were recorded in.
  db.seed("item_forward_events", [ev(B, "2026-10-01T00:00:00Z"), ev(A, "2026-10-02T00:00:00Z"), ev("0c000000-0000-4000-8000-00000000000c", "2026-10-03T00:00:00Z", { event_date: "2026-11-29" })]);
  const r = await readUpcoming(db.client, { limit: 10 }, "2026-10-16");
  assert.deepEqual(r.events.map((e) => e.id), ["0c000000-0000-4000-8000-00000000000c", B, A]);
});
