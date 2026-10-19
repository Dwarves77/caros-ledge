// R2d, I13: the readers in the surfaces' write set take the predicate, each shown on rows that are unverified, archived or replaced (the structure test, readers.test.ts, proves none was forgotten; these prove the
// ones that matter read the same rows the list reads).
import assert from "node:assert/strict";
import { test } from "node:test";

import { readItemRows } from "@/features/dashboard/read/items";
import { readMapItems } from "@/features/regulations/map/read";
import { relatedItems } from "@/features/research/read/related-items";

import { memoryDb, type Row } from "../_support/memory-db.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const item = (id: string, over: Row = {}): Row => ({ id, legacy_id: `l-${id.slice(-2)}`, title: `Item ${id.slice(-2)}`, domain: 1, source_id: "s1", added_date: "2026-10-01", provenance_status: "verified", is_archived: false, replaced_by: null, priority: "MODERATE", ...over });
const A = "a0000000-0000-4000-8000-000000000001";
const B = "a0000000-0000-4000-8000-000000000002";
const C = "a0000000-0000-4000-8000-000000000003";
const D = "a0000000-0000-4000-8000-000000000004";
const mixed = (): Row[] => [item(A), item(B, { provenance_status: "unverified" }), item(C, { is_archived: true }), item(D, { replaced_by: A })];

test("the dashboard's by-id backfill returns only admissible items: an unverified, archived or replaced item is not drawn", async () => {
  const m = memoryDb({ intelligence_items: mixed() });
  const rows = await readItemRows(m.db, [A, B, C, D]);
  assert.deepEqual(rows.map((r) => r.id), [A]);
});

test("the research related-items read takes admissible items only", async () => {
  const m = memoryDb({ intelligence_items: [item("a0000000-0000-4000-8000-000000000009"), ...mixed()] });
  const r = await relatedItems(m.db, { id: "a0000000-0000-4000-8000-000000000009", sourceId: "s1" }, null);
  assert.equal(r.failed, false);
  assert.deepEqual(r.items.map((i) => i.id), ["l-01"]);
});

test("S:10: the map reads the list's own workspace RPC, so a retagged item is the list's band on the map and an item the workspace archived is not on it", async () => {
  const listing = (a: Record<string, unknown>, d: { rows(t: string): Row[] }) => {
    const mine = d.rows("workspace_item_overrides").filter((o) => o.org_id === a.p_org_id);
    return { data: d.rows("intelligence_items").filter((i) => i.provenance_status === "verified" && i.domain === a.p_domain).map((i) => { const o = mine.find((x) => x.item_id === i.id); return { ...i, effective_priority: o?.priority_override ?? i.priority, effective_archived: o?.is_archived ?? i.is_archived }; }) };
  };
  const m = memoryDb({
    intelligence_items: [item(A, { priority: "LOW" }), item(B, { priority: "HIGH" }), item(C, { provenance_status: "unverified" })],
    workspace_item_overrides: [{ org_id: ORG, item_id: A, priority_override: "CRITICAL", is_archived: false }, { org_id: ORG, item_id: B, priority_override: null, is_archived: true }],
  });
  const base = m.mem.rpc.bind(m.mem);
  const withRange = (name: string, args: Record<string, unknown>) => Object.assign(Promise.resolve(base(name, args)), { range: () => base(name, args) });
  m.mem.rpcs.get_workspace_intelligence_listings = (a, d) => listing(a, d);
  (m.db as { rpc: unknown }).rpc = (name: string, args: Record<string, unknown>) => withRange(name, args);
  const items = await readMapItems(m.db, ORG);
  assert.deepEqual(items.map((i) => [i.id, i.priority]), [["l-01", "CRITICAL"]]);
});

test("S:10: a failed listing read fails the map; it is never an empty map", async () => {
  const m = memoryDb({ intelligence_items: [] });
  (m.db as { rpc: unknown }).rpc = () => Object.assign(Promise.resolve({ data: null, error: { message: "down" } }), { range: () => Promise.resolve({ data: null, error: { message: "down" } }) });
  await assert.rejects(() => readMapItems(m.db, ORG), /down/);
});
