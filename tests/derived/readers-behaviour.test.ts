// R2d, I13: the readers in the surfaces' write set take the predicate, each shown on rows that are unverified, archived or replaced (the structure test, readers.test.ts, proves none was forgotten; these prove the
// ones that matter read the same rows the list reads).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readItemRows } from "@/features/dashboard/read/items";
import { getMapItems } from "@/features/regulations/map/read";
import { rollup } from "@/features/regulations/map/rollup";
import { relatedItems } from "@/features/research/read/related-items";

import { memoryDb, type Row } from "../_support/memory-db.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const item = (id: string, over: Row = {}): Row => ({ id, legacy_id: `l-${id.slice(-2)}`, title: `Item ${id.slice(-2)}`, domain: 1, source_id: "s1", added_date: "2026-10-01", provenance_status: "verified", is_archived: false, replaced_by: null, priority: "MODERATE", ...over });
const A = "a0000000-0000-4000-8000-000000000001";
const B = "a0000000-0000-4000-8000-000000000002";
const C = "a0000000-0000-4000-8000-000000000003";
const D = "a0000000-0000-4000-8000-000000000004";
const mixed = (): Row[] => [item(A), item(B, { provenance_status: "unverified" }), item(C, { is_archived: true }), item(D, { replaced_by: A })];

test("I13, surfaces:80: the dashboard's by-id backfill and the portfolio's held read are the workspace's own rows, from get_workspace_items_by_ids (migration 0095): the org and the ids go to the database in chunks, the database says which items the workspace holds and at what priority, and a failed chunk rejects", async () => {
  const calls: Array<{ name: string; args: { p_org_id: string; p_ids: string[] } }> = [];
  const ids = Array.from({ length: 250 }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const m = memoryDb({}, { rpc: (name, args) => (calls.push({ name, args: args as never }), { data: (args as { p_ids: string[] }).p_ids.slice(0, 1).map((id) => ({ id, effective_priority: "HIGH" })) }) });
  const rows = await readItemRows(m.db, ORG, ids);
  assert.ok(calls.length >= 2 && calls.every((c) => c.name === "get_workspace_items_by_ids" && c.args.p_org_id === ORG && c.args.p_ids.length <= 150), "one call per chunk, never a table read");
  assert.equal(rows.length, calls.length);
  assert.ok(rows.every((r) => r.effective_priority === "HIGH"), "the priority is the database's, not merged by hand");
  assert.equal(m.reads.filter((l) => l.table === "intelligence_items" || l.table === "workspace_item_overrides").length, 0, "the overrides are not read here any more");
  await assert.rejects(readItemRows(memoryDb({}, { rpc: () => ({ error: { message: "down" } }) }).db, ORG, [A]), /get_workspace_items_by_ids failed: down/);
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
  const read = await getMapItems(m.db, ORG);
  assert.deepEqual(read.map((i) => [i.id, i.priority]), [["l-01", "CRITICAL"]]);
});

test("S:10: a failed listing read fails the map; it is never an empty map", async () => {
  const m = memoryDb({ intelligence_items: [] });
  (m.db as { rpc: unknown }).rpc = () => Object.assign(Promise.resolve({ data: null, error: { message: "down" } }), { range: () => Promise.resolve({ data: null, error: { message: "down" } }) });
  await assert.rejects(getMapItems(m.db, ORG), /down/, "a failed listing read is a failed read, never an empty map");
});

test("the map is read live: two reads with changed counts give changed counts and a changed order, and the reader holds no cache", async () => {
  const row = (id: string, iso: string) => ({ id, legacy_id: id, title: id, effective_priority: "MODERATE", effective_archived: false, jurisdictions: [iso], jurisdiction_iso: [iso], transport_modes: [], category: null });
  let rows = [row("a1", "DE"), row("a2", "DE"), row("f1", "FR")];
  const m = memoryDb({});
  (m.db as { rpc: unknown }).rpc = () => Object.assign(Promise.resolve({ data: rows, error: null }), { range: () => Promise.resolve({ data: rows, error: null }) });
  const order = async () => rollup(await getMapItems(m.db, ORG)).map((j) => [j.key, j.count]);
  assert.deepEqual(await order(), [["DE", 2], ["FR", 1]]);
  rows = [row("f1", "FR"), row("f2", "FR"), row("f3", "FR"), row("a1", "DE")];
  assert.deepEqual(await order(), [["FR", 3], ["DE", 1]], "the changed rows are drawn on the next read, in the changed order");
  rows = [row("a1", "DE"), row("f1", "FR")];
  assert.deepEqual(await order(), [["FR", 1], ["DE", 1]], "equal counts tie by label (France before Germany), so the order is total");
  const src = readFileSync("src/features/regulations/map/read.ts", "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /unstable_cache|cachedRead|revalidate/i, "a page may not draw a cached count");
});
