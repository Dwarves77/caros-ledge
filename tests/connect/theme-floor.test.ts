// THEME-CODE-1 (ruling 58): a connection theme is written only at convergence >= theme.minConvergence (data/discovery.json). A cluster below the floor writes no theme and its members stay unthemed;
// a prior theme that now clusters below the floor is dissolved through the delta with reason below_floor. Convergence here is 2/n for an n-item chain on one surface (density 2/n, recency 1).
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG } from "@/core/flywheel/config";
import { diffThemes } from "@/core/flywheel/themes";
import { corpusPass } from "@/features/flywheel/corpus-pass";

import { connectDb as memoryDb } from "./world.ts";

const NOW = new Date("2026-10-15T00:00:00Z");
type Row = Record<string, unknown>;
const item = (id: string): Row => ({ id, item_type: "regulation", domain: 1, priority: "LOW", provenance_status: "verified", is_archived: false, jurisdiction_iso: ["DE"], added_date: "2026-01-01", title: `Item ${id}`, topic_tags: [], canonical_instrument_key: null, operational_scenario_tags: [], compliance_object_tags: [], related_items: [] });
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
const chain = (names: string[]): Row[] => names.slice(1).map((b, i) => ({ id: `e-${names[i]}-${b}`, source_item_id: names[i], target_item_id: b, relationship: "related", origin: "provenance_discovery", score: 0.85, basis: [{ signal: "shared_entity", weight: 0.85 }] }));
const world = (clusters: string[][], extra: Record<string, Row[]> = {}) =>
  memoryDb({ intelligence_items: clusters.flat().map(item), workspace_settings: [{ jurisdiction_weights: {} }], item_cross_references: clusters.flatMap(chain), ...extra }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });

test("the floor is data: theme.minConvergence is 0.10 in the config the pass reads", () => {
  assert.equal(CONFIG.theme.minConvergence, 0.1);
});

test("a 0.04 cluster writes no theme and a 0.13 cluster does; the dry run reports the same", async () => {
  const low = ids("l", 50);
  const ok = ids("k", 15);
  const dry = await corpusPass({ sb: world([low, ok]).db, now: () => NOW }, { dry: true });
  const m = world([low, ok]);
  const out = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(out.outcome, "ok", out.notes.join("; "));
  const themes = m.tables.connection_themes as Row[];
  assert.equal(themes.length, 1, "only the cluster at or above the floor is written");
  assert.equal((themes[0]?.member_ids as string[]).length, 15);
  assert.ok((themes[0]?.convergence as number) >= 0.1 && (themes[0]?.convergence as number) < 0.14);
  assert.equal(out.counts.themes, 1);
  assert.equal(dry.counts.themes, 1);
  assert.equal(out.data?.themes, 1);
});

test("a theme that falls below the floor on a later pass is dissolved with reason below_floor and its members are unthemed", async () => {
  const members = ids("m", 15);
  const m = world([members]);
  const first = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal((m.tables.connection_themes as Row[]).length, 1, first.notes.join("; "));
  const priorId = (m.tables.connection_themes as Row[])[0]?.id as string;
  // 35 more items join the same chain: the theme is now 50 items at 0.04
  const grown = ids("m", 50);
  for (const id of grown.slice(15)) (m.tables.intelligence_items as Row[]).push(item(id));
  (m.tables.item_cross_references as Row[]).length = 0;
  (m.tables.item_cross_references as Row[]).push(...chain(grown));
  const second = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(second.outcome, "ok", second.notes.join("; "));
  assert.equal((m.tables.connection_themes as Row[]).length, 0, "no theme above the floor remains");
  assert.deepEqual(second.data?.themeDelta?.dissolved, [priorId]);
  assert.deepEqual(second.data?.themeDelta?.below_floor, [priorId]);
  assert.equal(second.counts.delta_below_floor, 1);
  const run = (m.tables.connection_theme_runs as Row[]).at(-1);
  assert.deepEqual((run?.theme_delta as { below_floor: string[] }).below_floor, [priorId], "the reason is stored on the run");
});

test("diffThemes: a dissolved theme with no sub-floor cluster over its members carries no below_floor reason", () => {
  const d = diffThemes([{ id: "P", members: ["a", "b"] }], [], { belowFloor: [{ id: "Q", members: ["x", "y"] }] });
  assert.deepEqual([d.dissolved, d.below_floor], [["P"], []]);
  assert.deepEqual(diffThemes([{ id: "P", members: ["a", "b"] }], [], { belowFloor: [{ id: "Q", members: ["a", "b", "c"] }] }).below_floor, ["P"]);
});
