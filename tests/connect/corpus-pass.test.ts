// The whole-corpus pass on a stateful fake: dry writes nothing, apply replaces the themes wholesale in one run row, a second pass over unchanged data
// yields an empty theme delta (INV-190), a manual edge survives, and a failed read is an error, never an empty corpus.
import assert from "node:assert/strict";
import { test } from "node:test";

import { corpusPass, sharedEntityEdges } from "@/features/flywheel/corpus-pass";
import { regulationEntityTokens } from "@/core/flywheel/signature";

import { connectDb as memoryDb } from "./world.ts";

const NOW = new Date("2026-10-15T00:00:00Z");
type Row = Record<string, unknown>;
const item = (id: string, over: Row = {}): Row => ({ id, item_type: "regulation", domain: 1, priority: "LOW", provenance_status: "verified", is_archived: false, jurisdiction_iso: ["DE"], added_date: "2026-01-01", title: `Item ${id}`, topic_tags: [], canonical_instrument_key: null, operational_scenario_tags: [], compliance_object_tags: [], related_items: [], ...over });
const world = (extra: Record<string, Row[]> = {}) =>
  memoryDb({
    intelligence_items: [
      item("a", { operational_scenario_tags: ["s1"], compliance_object_tags: ["o1"] }),
      item("b", { item_type: "market_signal", domain: 2, operational_scenario_tags: ["s1"], compliance_object_tags: ["o1"] }),
      item("c", { operational_scenario_tags: ["s2"], compliance_object_tags: ["o2"] }),
      item("d", { operational_scenario_tags: ["s2"], compliance_object_tags: ["o2"] }),
      item("e", { title: "Lone item" }),
    ],
    workspace_settings: [{ jurisdiction_weights: {} }],
    ...extra,
  }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });

test("dry run writes nothing and reports the same counts as apply", async () => {
  const m = world();
  const dry = await corpusPass({ sb: m.db, now: () => NOW }, { dry: true });
  assert.equal(dry.outcome, "ok");
  assert.equal(dry.counts.intersection_pairs, 2);
  assert.equal(dry.counts.intersection_cross_surface, 1);
  for (const t of ["item_cross_references", "connection_themes", "connection_theme_runs", "integrity_flags"]) assert.equal(m.wrote(t).filter((w) => w.op !== "select").length, 0, `${t} untouched`);
  const applied = await corpusPass({ sb: world().db, now: () => NOW }, { dry: false });
  assert.equal(applied.counts.intersection_pairs, dry.counts.intersection_pairs);
  assert.equal(applied.counts.themes, dry.counts.themes);
});

test("apply replaces the themes wholesale; a second pass over unchanged data has an empty delta (INV-190)", async () => {
  const m = world();
  const first = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(first.outcome, "ok", first.notes.join("; "));
  const themes = m.tables.connection_themes as Row[];
  assert.equal(themes.length, 2);
  assert.deepEqual(themes.map((t) => (t.member_ids as string[]).join(",")).sort(), ["a,b", "c,d"]);
  assert.equal((m.tables.connection_theme_runs as Row[]).length, 1);
  const second = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  const d = second.data?.themeDelta;
  assert.ok(d);
  assert.equal(d.dissolved.length + d.appeared.length + d.split.length + d.merged.length + d.renamed.length, 0);
  assert.equal(d.persisted.length, 2);
  assert.equal((m.tables.connection_themes as Row[]).length, 2, "replaced, not appended");
  const dry = await corpusPass({ sb: m.db, now: () => NOW }, { dry: true });
  assert.equal(dry.data?.themeDelta?.summary.persisted, 2);
  assert.equal((dry.data?.themeDelta?.summary.dissolved ?? 1) + (dry.data?.themeDelta?.summary.appeared ?? 1), 0);
});

test("a manual edge between two intersecting items is never overwritten", async () => {
  const m = world({ item_cross_references: [{ id: "x1", source_item_id: "a", target_item_id: "b", relationship: "supersedes", origin: "manual", score: 1, basis: [] }] });
  const r = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(r.counts.intersection_skipped_manual, 1);
  const row = (m.tables.item_cross_references as Row[]).find((x) => x.source_item_id === "a" && x.target_item_id === "b");
  assert.equal(row?.origin, "manual");
  assert.equal(row?.relationship, "supersedes");
});

test("a failed item read rejects; it is never an empty corpus that dissolves every theme", async () => {
  const m = memoryDb({ workspace_settings: [{}] }, { failures: [{ table: "intelligence_items", op: "select", message: "down" }] });
  await assert.rejects(() => corpusPass({ sb: m.db, now: () => NOW }, { dry: false }));
  assert.equal(m.writes.filter((w) => w.op !== "select").length, 0);
});

test("shared-entity edges: two items naming one regulation identifier, no edge between them, get both directions", () => {
  const items = [{ id: "a", title: "Regulation (EU) 2023/1805 on fuels" }, { id: "b", title: "Guidance on 2023/1805" }, { id: "c", title: "Unrelated" }];
  const out = sharedEntityEdges(items, [], regulationEntityTokens);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => `${e.source_item_id}>${e.target_item_id}`).sort(), ["a>b", "b>a"]);
  assert.equal(out[0]?.basis?.[0]?.weight, 0.85);
  assert.equal(sharedEntityEdges(items, [{ source_item_id: "b", target_item_id: "a" }], regulationEntityTokens).length, 0, "an existing edge in either direction suppresses it");
});

test("IMP-047: the pass's run id reaches the default snapshot sink: the prior edge rows are in edge_snapshots under that run, taken before the refresh", async () => {
  const RUN = "99999999-9999-4999-8999-999999999999";
  const m = world({ item_cross_references: [{ id: "x1", source_item_id: "a", target_item_id: "b", relationship: "related", origin: "provenance_discovery", score: 0.3, basis: [] }] });
  const r = await corpusPass({ sb: m.db, now: () => NOW, runId: RUN }, { dry: false });
  assert.equal(r.outcome, "ok", r.notes.join("; "));
  const snaps = m.tables.edge_snapshots as Row[];
  assert.equal(snaps.length, 1);
  assert.deepEqual([snaps[0]?.run_id, snaps[0]?.table_name, (snaps[0]?.rows as Row[])[0]?.id], [RUN, "item_cross_references", "x1"]);
  assert.deepEqual((snaps[0]?.rows as Row[])[0]?.basis, [], "the snapshot is the state before the pass");
  const dry = world({ item_cross_references: [{ id: "x1", source_item_id: "a", target_item_id: "b", relationship: "related", origin: "provenance_discovery", score: 0.3, basis: [] }] });
  await corpusPass({ sb: dry.db, now: () => NOW, runId: RUN }, { dry: true });
  assert.equal(dry.tables.edge_snapshots, undefined, "a dry run snapshots nothing");
});
