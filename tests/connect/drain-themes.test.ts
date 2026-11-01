// DRAIN-THEMES-1: the corpus pass that replaces the themes also retires the briefs of themes it dissolved and counts (and names) the themes that owe a brief; the drain planner puts owed theme briefs ahead of every item kind.
// INV-DT-1 orphan retired in the same pass (dry plans it, writes nothing); INV-DT-2 owed = new themes with no or a stale brief; INV-DT-3 planDrain order and switch; INV-DT-4 a re-cluster leaves 0 live orphan briefs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeMemberHash } from "@/core/flywheel/themes";
import { planDrain, type DrainDeps, type Exporter } from "@/features/drain";
import { corpusPass } from "@/features/flywheel/corpus-pass";

import { connectDb as memoryDb } from "./world.ts";

const NOW = new Date("2026-10-31T00:00:00Z");
type Row = Record<string, unknown>;
const item = (id: string, over: Row = {}): Row => ({ id, item_type: "regulation", domain: 1, priority: "LOW", provenance_status: "verified", is_archived: false, jurisdiction_iso: ["DE"], added_date: "2026-01-01", title: `Item ${id}`, topic_tags: [], canonical_instrument_key: null, operational_scenario_tags: [], compliance_object_tags: [], related_items: [], ...over });
const world = () =>
  memoryDb({
    intelligence_items: [
      item("a", { operational_scenario_tags: ["s1"], compliance_object_tags: ["o1"] }),
      item("b", { item_type: "market_signal", domain: 2, operational_scenario_tags: ["s1"], compliance_object_tags: ["o1"] }),
      item("c", { operational_scenario_tags: ["s2"], compliance_object_tags: ["o2"] }),
      item("d", { operational_scenario_tags: ["s2"], compliance_object_tags: ["o2"] }),
    ],
    workspace_settings: [{ jurisdiction_weights: {} }],
  }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
const brief = (theme_id: string, members: string[], over: Row = {}): Row => ({ theme_id, title: `Brief ${theme_id}`, brief_md: "text", member_hash: computeMemberHash(members), member_count: members.length, generated_at: "2026-10-30T00:00:00Z", generated_by: "x", member_ids: members, superseded_at: null, ...over });
const themeOf = (m: ReturnType<typeof world>, members: string) => (m.tables.connection_themes as Row[]).find((t) => (t.member_ids as string[]).join(",") === members) as Row;
const live = (m: ReturnType<typeof world>) => (m.tables.theme_briefs as Row[] | undefined ?? []).filter((b) => !b.superseded_at);

test("INV-DT-2: the pass reports theme_briefs_owed = new themes with no brief or a stale one, and names them", async () => {
  const m = world();
  const first = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(first.counts.theme_briefs_owed, 2);
  assert.deepEqual([...(first.data?.ids?.theme_briefs_owed ?? [])].sort(), (m.tables.connection_themes as Row[]).map((t) => String(t.id)).sort());
  const ab = themeOf(m, "a,b");
  m.tables.theme_briefs = [brief(String(ab.id), ["a", "b"])];
  assert.equal((await corpusPass({ sb: m.db, now: () => NOW }, { dry: false })).counts.theme_briefs_owed, 1, "ab is current; cd has none");
  m.tables.theme_briefs = [brief(String(ab.id), ["a", "b", "z"], { member_hash: computeMemberHash(["a", "b", "z"]) })];
  assert.equal((await corpusPass({ sb: m.db, now: () => NOW }, { dry: false })).counts.theme_briefs_owed, 2, "a stale brief is owed a replacement");
  assert.equal(live(m).length, 1, "the stale brief is not retired: it keeps rendering until its replacement applies");
});

test("INV-DT-1 and INV-DT-4: a re-cluster that dissolves a briefed theme retires its brief in the same pass; dry plans it and writes nothing; 0 live orphans after", async () => {
  const m = world();
  await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  const ab = String(themeOf(m, "a,b").id);
  m.tables.theme_briefs = [brief(ab, ["a", "b"])];
  for (const it of m.tables.intelligence_items as Row[]) if (it.id === "a" || it.id === "b") Object.assign(it, { operational_scenario_tags: [], compliance_object_tags: [] });
  const dry = await corpusPass({ sb: m.db, now: () => NOW }, { dry: true });
  assert.equal(dry.counts.orphan_briefs_retired, 1);
  assert.equal(m.wrote("theme_briefs").filter((w) => w.op !== "select").length, 0, "dry writes nothing");
  assert.equal(live(m).length, 1);
  const applied = await corpusPass({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(applied.outcome, "ok", applied.notes.join("; "));
  assert.equal(applied.counts.orphan_briefs_retired, 1);
  const ids = new Set((m.tables.connection_themes as Row[]).map((t) => String(t.id)));
  assert.equal(live(m).filter((b) => !ids.has(String(b.theme_id))).length, 0, "no live brief names a theme that is gone");
  assert.ok((m.tables.theme_briefs as Row[])[0]?.superseded_at);
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const planDeps = (on: boolean, exporters: Record<string, Exporter>): DrainDeps => ({
  readSwitch: async () => ({ on, reason: on ? null : "off", judgementDrain: on ? "on" : "off", emergencyPaused: false, fleetHalted: false, readFailed: false }),
  exporters, listBatchDir: () => [], acquire: async () => ({ acquired: true, cur_holder: "h" }), release: async () => true, now: () => NOW,
});
const exporters: Record<string, Exporter> = {
  "item-briefs": async () => ({ ok: true, items: [{ id: U(1), created_at: "2026-01-01T00:00:00Z" }] }),
  "theme-briefs": async () => ({ ok: true, items: [{ theme_id: U(2) }] }),
};

test("INV-DT-3: with owed theme briefs and the switch on, theme-briefs is planned before the older item kind; switch off plans nothing", async () => {
  const on = await planDrain(planDeps(true, exporters), { runId: "r1", dry: true, kinds: ["item-briefs", "theme-briefs"] });
  assert.deepEqual(on.kinds.map((k) => k.kind), ["theme-briefs", "item-briefs"]);
  const none = await planDrain(planDeps(true, { ...exporters, "theme-briefs": async () => ({ ok: true, items: [] }) }), { runId: "r2", dry: true, kinds: ["item-briefs", "theme-briefs"] });
  assert.equal(none.kinds[0]?.kind, "item-briefs", "nothing owed: the order is unchanged");
  const off = await planDrain(planDeps(false, exporters), { runId: "r3", kinds: ["item-briefs", "theme-briefs"] });
  assert.deepEqual([off.drain, off.kinds.length], ["off", 0]);
});
