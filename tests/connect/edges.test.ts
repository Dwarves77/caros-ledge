// INV-187/206 (edge ownership and origin), the relationship and surface drift checks, and the adversarial writer test: a MANUAL row, a foreign-origin
// row and a tombstoned pair are skipped and counted, never overwritten.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { edgeSnapshotSink, RELATIONSHIPS, writeDiscoveredEdges, type EdgeRow } from "@/core/flywheel/edges";
import { renderSurfaceOfSql, SURFACE_RULES, surfaceOf } from "@/core/routing";

import { memoryDb } from "../_support/memory-db.ts";

const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");

test("relationship table equals the CHECK of item_cross_references", () => {
  const m = /item_cross_references_relationship_check CHECK \(\(relationship = ANY \(ARRAY\[([^\]]+)\]/.exec(schema);
  assert.ok(m, "the CHECK exists in schema.sql");
  const inDb = [...(m[1] as string).matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1] as string).sort();
  assert.deepEqual([...RELATIONSHIPS].sort(), inDb);
});

test("SURFACE_RULES renders the body of public.surface_of", () => {
  const m = /CREATE FUNCTION public\.surface_of[\s\S]*?SELECT\s+(CASE[\s\S]*?END);/.exec(schema);
  assert.ok(m, "surface_of exists in schema.sql");
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.equal(squash(renderSurfaceOfSql()), squash(m[1] as string));
  assert.equal(surfaceOf("regulation", 5), "regulations");
  assert.equal(surfaceOf(null, 7), "research");
  assert.equal(surfaceOf("unknown_type", null), "uncategorized");
  assert.ok(SURFACE_RULES.length > 0);
});

const edge = (s: string, t: string, origin = "provenance_discovery", extra: Partial<EdgeRow> = {}): EdgeRow => ({ source_item_id: s, target_item_id: t, relationship: "related", origin, score: 0.5, basis: [], ...extra });

test("adversarial writer: manual, foreign-origin and tombstoned pairs are skipped and counted; own-origin is refreshed", async () => {
  const m = memoryDb({
    item_cross_references: [
      { id: "e1", source_item_id: "a", target_item_id: "b", relationship: "supersedes", origin: "manual", score: 1, basis: [] },
      { id: "e2", source_item_id: "a", target_item_id: "c", relationship: "implements", origin: "entity_extraction", score: 1, basis: [] },
      { id: "e3", source_item_id: "a", target_item_id: "d", relationship: "related", origin: "provenance_discovery", score: 0.3, basis: [] },
    ],
    item_corrections: [{ id: "c1", item_id: "a", target_kind: "connection", target_ref: "e", op: "remove", created_at: "2026-01-01T00:00:00Z", revoked_at: null }],
  }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
  const snaps: number[] = [];
  const r = await writeDiscoveredEdges(m.db, [edge("a", "b"), edge("a", "c"), edge("a", "d", "provenance_discovery", { score: 0.9 }), edge("a", "e"), edge("a", "f")], { snapshot: (_t, rows) => void snaps.push(rows.length) });
  assert.equal(r.skippedForeignOrigin, 2, "manual and entity_extraction rows are never touched");
  assert.equal(r.skippedTombstoned, 1, "the removed pair is never re-created");
  assert.equal(r.refreshed, 1);
  assert.equal(r.inserted, 1);
  assert.deepEqual(snaps, [1], "the prior own-origin row is snapshotted before the overwrite");
  const rows = m.tables.item_cross_references as unknown as EdgeRow[];
  assert.equal(rows.find((x) => x.target_item_id === "b")?.relationship, "supersedes");
  assert.equal(rows.find((x) => x.target_item_id === "b")?.origin, "manual");
  assert.equal(rows.find((x) => x.target_item_id === "c")?.origin, "entity_extraction");
  assert.equal(rows.find((x) => x.target_item_id === "d")?.score, 0.9);
  assert.equal(rows.some((x) => x.target_item_id === "e"), false);
  assert.equal(rows.some((x) => x.target_item_id === "f"), true);
});

test("a failed existing-edge read throws; it is never an empty list", async () => {
  const m = memoryDb({}, { failures: [{ table: "item_cross_references", op: "select", message: "boom" }] });
  await assert.rejects(() => writeDiscoveredEdges(m.db, [edge("a", "b")]), /existing-edge read failed/);
  assert.equal(m.wrote("item_cross_references").length, 0);
});

test("a failed correction read throws before any write", async () => {
  const m = memoryDb({}, { failures: [{ table: "item_corrections", op: "select", message: "boom" }] });
  await assert.rejects(() => writeDiscoveredEdges(m.db, [edge("a", "b")]), /item_corrections read failed/);
  assert.equal(m.wrote("item_cross_references").length, 0);
});

test("IMP-047: with a harness run id the prior rows are stored in edge_snapshots before the overwrite, in chunks; a failed snapshot write stops the overwrite", async () => {
  const RUN = "99999999-9999-4999-8999-999999999999";
  const prior = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, source_item_id: "a", target_item_id: `t${i}`, relationship: "related", origin: "provenance_discovery", score: 0.3, basis: [] }));
  const m = memoryDb({ item_cross_references: prior(3), item_corrections: [] }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
  const r = await writeDiscoveredEdges(m.db, prior(3).map((e) => edge("a", e.target_item_id, "provenance_discovery", { score: 0.9 })), { runId: RUN });
  assert.equal(r.refreshed, 3);
  const snaps = m.tables.edge_snapshots as Record<string, unknown>[];
  assert.equal(snaps.length, 1);
  assert.deepEqual([snaps[0]?.run_id, snaps[0]?.table_name], [RUN, "item_cross_references"]);
  assert.deepEqual((snaps[0]?.rows as EdgeRow[]).map((x) => x.score), [0.3, 0.3, 0.3], "the snapshot holds the state BEFORE the refresh");
  assert.ok((m.tables.item_cross_references as unknown as EdgeRow[]).every((x) => x.score === 0.9), "and the rows were then refreshed");
  const chunked = memoryDb({});
  await edgeSnapshotSink(chunked.db, RUN, 2)("item_cross_references", prior(5) as EdgeRow[]);
  assert.deepEqual((chunked.tables.edge_snapshots as Record<string, unknown[]>[]).map((x) => (x.rows as unknown[]).length), [2, 2, 1]);
  const down = memoryDb({ item_cross_references: prior(1), item_corrections: [] }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] }, failures: [{ table: "edge_snapshots", op: "insert", message: "disk full" }] });
  await assert.rejects(writeDiscoveredEdges(down.db, [edge("a", "t0", "provenance_discovery", { score: 0.9 })], { runId: RUN }), /edge snapshot write failed: disk full/);
  assert.equal((down.tables.item_cross_references as unknown as EdgeRow[])[0]?.score, 0.3, "nothing was overwritten without its evidence");
  const none = memoryDb({ item_cross_references: prior(1), item_corrections: [] }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
  await writeDiscoveredEdges(none.db, [edge("a", "t0", "provenance_discovery", { score: 0.9 })], {});
  assert.equal(none.tables.edge_snapshots, undefined, "no run id and no sink: no snapshot, as before");
});
