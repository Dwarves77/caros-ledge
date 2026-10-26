// CONNECT-2: the fixture turn. The propagate stage seeds the vocabulary and mines the planted claims and typed rows into entity_refs; the connect stage then runs all five detectors, and the planted data yields exactly the planted patterns: one per kind and one per relation kind
// the cross-modal detector crosses (INV-CN2-5, less the needs-search row, which is PR B). Each pattern is a derived value under its registered method with one derivation edge per evidence row (INV-CN2-1); a second connect finds the same patterns and writes none.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PATTERN_METHODS } from "@/core/propagation/methods";

import { connect, countsOf, E, OBLIGATION, patternFixture, patterns, propagate } from "./_world.ts";

const byMethod = (rows: Record<string, unknown>[]) => Object.fromEntries(Object.values(PATTERN_METHODS).map((m) => [m.id, rows.filter((r) => r.method_id === m.id).length]));

test("INV-CN2-5: the planted data yields exactly one pattern per kind and one cross-modal pattern per relation kind, no other", async () => {
  const f = patternFixture();
  assert.equal((await propagate(f)).exit, 0);
  assert.equal((await connect(f)).exit, 0);
  const rows = patterns(f);
  assert.deepEqual(byMethod(rows), { pattern_velocity_burst: 1, pattern_mandate_capacity: 1, pattern_lead_lag: 1, pattern_cross_modal: 8, pattern_penalty_abatement: 1 });
  const cross = rows.filter((r) => r.method_id === "pattern_cross_modal").map((r) => String(r.computed_by).split("|")[1]).sort();
  assert.deepEqual(cross, ["competes_for_feedstock", "consignment_wide", "consignment_wide", "corridor_links", "corridor_links", "corridor_links", "feedstock_of", "shares_grid_zone"]);
  // the join fixes: a mode-agnostic mandate and the two corridors that link road each carry a spill from a road ratchet (P4)
  const keys = rows.filter((r) => r.method_id === "pattern_cross_modal").map((r) => String(r.computed_by));
  for (const target of ["instrument:32025R0040", "corridor:rail_road", "corridor:inland_waterway"]) assert.ok(keys.some((k) => k.includes(`|${OBLIGATION.road}|`) || (k.includes(OBLIGATION.road) && k.endsWith(E(target)))), target);
  const anchor = (id: string) => rows.find((r) => r.method_id === id)?.entity_id;
  assert.equal(anchor("pattern_velocity_burst"), E("carrier:green_ammonia"));
  assert.equal(anchor("pattern_penalty_abatement"), E("carrier:bio_methanol"));
  assert.equal(countsOf(f, "corpus-turn").patterns, 12, "the stage's ledger row carries the count per kind");
  assert.deepEqual([countsOf(f, "corpus-turn").patterns_velocity, countsOf(f, "corpus-turn").patterns_crossModal], [1, 8]);
});

test("INV-CN2-1: every pattern value names its evidence: member, evidence or key edges, one per evidence row, and the method version is recorded", async () => {
  const f = patternFixture();
  await propagate(f);
  await connect(f);
  const edges = f.db.rows("derivation_edges");
  for (const p of patterns(f)) {
    const mine = edges.filter((e) => e.to_value_id === p.value_id);
    assert.ok(mine.length >= 1, `${String(p.method_id)} has evidence edges`);
    assert.ok(mine.every((e) => ["member", "evidence", "key"].includes(String(e.edge_kind))));
    assert.equal(new Set(mine.map((e) => `${String(e.from_table)}/${String(e.from_pk)}/${String(e.edge_kind)}`)).size, mine.length, "one edge per evidence row");
    assert.equal(p.method_version, p.method_id === "pattern_penalty_abatement" ? "1.2.0" : "1.1.0");
    assert.ok(["analysis_ok", "display_only"].includes(String(p.admissibility)), "graded");
  }
  const velocity = patterns(f).find((p) => p.method_id === "pattern_velocity_burst");
  const kinds = edges.filter((e) => e.to_value_id === velocity?.value_id).map((e) => e.edge_kind);
  assert.equal(kinds.filter((k) => k === "member").length, 3, "the three claims of the burst");
  assert.equal(kinds.filter((k) => k === "key").length, 1, "the baseline is one summary edge");
});

test("a second connect finds the same patterns and writes none; a retired input retires the pattern", async () => {
  const f = patternFixture();
  await propagate(f);
  await connect(f);
  const first = patterns(f).length;
  await connect(f);
  assert.equal(patterns(f).length, first);
  assert.equal(countsOf(f, "corpus-turn").patterns_unchanged, first);
  // the burst's claims fall out of the window: the pattern is retired, not left standing
  const aged = new Set(f.db.rows("section_claim_provenance").filter((x) => String(x.claim_text).startsWith("Green ammonia")).map((x) => x.intelligence_item_id));
  for (const i of f.db.rows("intelligence_items").filter((x) => aged.has(x.id))) i.added_date = "2026-02-01";
  await propagate(f);
  await connect(f);
  const retired = patterns(f).filter((p) => p.method_id === "pattern_velocity_burst");
  assert.deepEqual(retired.map((p) => p.lifecycle), ["obsolete"]);
  assert.equal(retired[0]?.admissibility, "stale");
});

/** An outbox event for a row of an evidence table, as the table's propagation trigger writes it. */
const touch = (f: ReturnType<typeof patternFixture>, table: string, pk: string, id: number) => f.db.rows("propagation_events").push({ event_id: id, occurred_at: "2026-10-15T12:00:00.000Z", table_name: table, row_pk: pk, entity_id: null, change_kind: "update", new_row: {}, drained_at: null });
const OEM = "a0000000-0000-4000-8000-000000000400";

test("the invalidation DAG: a changed evidence row marks the patterns citing it stale and the drain recomputes each through its registered method; one that still holds is superseded, one that no longer holds stays stale", async () => {
  const f = patternFixture();
  await propagate(f);
  await connect(f);
  const mandate = () => patterns(f).filter((p) => p.method_id === "pattern_mandate_capacity");
  const before = mandate().length;
  const first = mandate()[0];
  // the roadmap row changes but the collision stands: the drain recomputes it by the method that found it
  touch(f, "oem_tech_roadmaps", OEM, 9001);
  await propagate(f);
  const after = mandate();
  assert.equal(after.length, before * 2, "each stale value is kept, its successor is a new row");
  const successor = after.find((p) => p.supersedes === first?.value_id);
  assert.ok(successor, "the recomputed pattern supersedes the stale one");
  assert.equal(successor?.method_version, "1.1.0");
  assert.equal(first?.admissibility, "stale");
  assert.ok((countsOf(f, "propagation").recomputed ?? 0) >= 1);
  // the roadmap now lands before the deadline: the pattern no longer holds, the method refuses, the value stays stale
  const oem = f.db.rows("oem_tech_roadmaps")[0] as Record<string, unknown>;
  oem.target_year = 2025;
  touch(f, "oem_tech_roadmaps", OEM, 9002);
  await propagate(f);
  const live = mandate().filter((p) => p.admissibility !== "stale");
  assert.deepEqual(live, [], "no pattern stands over a roadmap that lands first");
  assert.equal(countsOf(f, "propagation").recomputed, 0, "the method refused: nothing was recomputed");
});

test("INV-CN2-6: the connect stage's corpus counts and theme delta are those of a turn with no pattern data: the patterns add nothing to the graph", async () => {
  const bare = patternFixture();
  const planted = patternFixture();
  bare.db.rows("section_claim_provenance").length = 0;
  for (const t of ["obligation_objects", "oem_tech_roadmaps", "item_forward_events", "market_series", "research_assessments", "statutory_computations", "derived_values"]) {
    if (t !== "market_series") bare.db.rows(t).length = 0;
  }
  await propagate(planted);
  await propagate(bare);
  await connect(planted);
  await connect(bare);
  const [a, b] = [countsOf(planted, "corpus-turn"), countsOf(bare, "corpus-turn")];
  for (const k of ["slice", "connected", "tag_items_written", "edges_written", "term_writes", "themes"]) assert.equal(a[k], b[k], k);
  assert.ok((a.patterns ?? 0) > 0 && (b.patterns ?? 0) === 0);
});
