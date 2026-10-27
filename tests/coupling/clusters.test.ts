// PATTERN-SYNTHESIS-1: the cluster assembler hands the AI multi-surface groups of rows read from many angles; a detector gates nothing. Run over fixture facts (no database): the four axes, the six angles assigned from which roles intersect, the id, the ranking and the truncation count.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ontologyOf, type Relation } from "@/core/coupling";
import { assembleClusters } from "@/core/flywheel/clusters";
import type { Fact, PatternInput } from "@/core/flywheel/patterns";

import { MemDb } from "../_support/memdb.ts";
import { E, FIXTURE_RELATIONS, fixtureRows } from "../_support/ontology.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const day = (offset: number): string => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const rows = fixtureRows();
const onto = ontologyOf({ entities: rows.entities as never, refs: rows.refs as never, relations: rows.relations as never });
const fact = (over: Partial<Fact>): Fact => ({ table: "t", pk: "p", role: "claim", entities: ["e1"], modes: [], surface: "regulations", at: null, due: null, source: null, tier: null, qty: null, unit: null, trl: null, kind: "FACT", group: null, ...over });
const related = (e: string) =>
  FIXTURE_RELATIONS.flatMap((r) => {
    const [p, c] = [E(r.parent), E(r.child)];
    return p === e ? [{ entity: c, relation: r.relation as Relation }] : c === e ? [{ entity: p, relation: r.relation as Relation }] : [];
  });
const input = (facts: Fact[]): PatternInput => ({ now: NOW, facts, related, flow: null, classOf: onto.classOf, modesOf: onto.modesOf });
const db = new MemDb().client;

test("A shared_entity: rows of two fronts filed under one specific entity are a cluster at 0 hops, with the date, figure and quote of each row; one front alone is none", async () => {
  const uco = E("feed:uco");
  const facts = [
    fact({ table: "obligation_objects", pk: "o1", role: "ratchet", entities: [uco], due: day(100), dueSource: "first_deadline", capture: "cap-1", surface: "regulations", item: "i1" }),
    fact({ table: "market_series", pk: "m1", role: "series", entities: [uco], at: day(-5), qty: 120, unit: "EUR/t", surface: "market" }),
    fact({ table: "market_series", pk: "m2", role: "series", entities: [E("feed:tallow")], at: day(-5), qty: 1, unit: "EUR/t", surface: "market" }),
  ];
  const { clusters, truncated } = await assembleClusters(db, { limit: 10, input: input(facts) });
  const c = clusters.find((x) => x.axes.includes("shared_entity") && x.anchor_entity_ids.includes(uco));
  assert.ok(c, "the cluster exists");
  assert.deepEqual([c?.hops, c?.surfaces, truncated], [0, ["market", "regulations"], 0]);
  assert.deepEqual(c?.rows.map((r) => [r.table, r.date, r.figure, r.quote_capture_id]).sort(), [["market_series", day(-5), { value: 120, unit: "EUR/t" }, null], ["obligation_objects", day(100), null, "cap-1"]]);
  assert.match(c?.id ?? "", /^[0-9a-f]{16}$/);
  assert.equal(clusters.some((x) => x.rows.every((r) => r.surface === "market")), false, "a single front is never a cluster at the default minimum of two");
  assert.equal((await assembleClusters(db, { limit: 10, input: input(facts), minSurfaces: 1 })).clusters.length > clusters.length, true, "minSurfaces is a parameter");
});

test("B relation_hops: rows under an entity and under what it reaches over entity_relations (one and two hops, any relation token) are a cluster that records its hops and axis", async () => {
  const saf = E("carrier:hefa_saf");
  const bunkers = E("carrier:bio_bunkers");
  const facts = [
    fact({ table: "obligation_objects", pk: "o1", role: "ratchet", entities: [saf], due: day(100), item: "i1", surface: "regulations" }),
    fact({ table: "market_series", pk: "m1", role: "series", entities: [bunkers], at: day(-5), qty: 2, unit: "ratio", surface: "market" }),
  ];
  const { clusters } = await assembleClusters(db, { limit: 10, input: input(facts) });
  const c = clusters.find((x) => x.axes.includes("relation_hops") && x.anchor_entity_ids.includes(saf) && x.anchor_entity_ids.includes(bunkers));
  assert.deepEqual([c?.hops, c?.surfaces], [1, ["market", "regulations"]]);
  assert.equal(clusters.some((x) => x.axes.includes("shared_entity") && x.rows.length === 2), false, "nothing is filed under one entity: no 0-hop cluster");
});

test("C scope_window: several instruments or operational events on one scope inside one window are a cluster; one instrument, or rows a year apart, are not", async () => {
  const hub = E("hub:seaport");
  const mk = (pk: string, item: string, due: string, surface: string, table = "obligation_objects", role: Fact["role"] = "ratchet") => fact({ table, pk, role, entities: [hub], due, item, surface });
  const stacked = await assembleClusters(db, { limit: 10, input: input([mk("a", "i1", day(100), "regulations"), mk("b", "i2", day(160), "operations", "reroute_events", "move")]) });
  assert.ok(stacked.clusters.some((c) => c.axes.includes("scope_window") && c.rows.length === 2));
  const apart = await assembleClusters(db, { limit: 10, input: input([mk("a", "i1", day(100), "regulations"), mk("b", "i2", day(600), "operations", "reroute_events", "move")]) });
  assert.equal(apart.clusters.some((c) => c.axes.includes("scope_window")), false);
});

test("D threshold: the six detectors run as one input and name their angle; the angles are also assigned from the roles that intersect, with no detector", async () => {
  const bm = E("carrier:bio_methanol");
  const facts = [
    fact({ table: "research_assessments", pk: "t1", role: "tech", entities: [bm], trl: 8, at: day(-5), surface: "research", item: "i9" }),
    fact({ table: "derived_values", pk: "a1", role: "abatement", entities: [bm], qty: 95, unit: "EUR/tCO2e", at: day(-5), surface: "market" }),
    fact({ table: "statutory_computations", pk: "k1", role: "ceiling", entities: [bm], qty: 100, unit: "EUR/tCO2e", surface: "regulations" }),
  ];
  const { clusters } = await assembleClusters(db, { limit: 10, input: input(facts) });
  const c = clusters.find((x) => x.axes.includes("threshold"));
  assert.ok(c, "the penalty and abatement pattern is a cluster");
  assert.deepEqual(c?.surfaces, ["market", "regulations", "research"]);
  assert.ok(c?.angles.includes("penalty_vs_abatement") && c.angles.includes("maturity_vs_statute"));
  // the angle of a group is assigned from the roles that intersect in it, whatever any detector found
  const e1 = E("feed:uco");
  const angles = async (fs: Fact[]) => [...new Set((await assembleClusters(db, { limit: 50, minSurfaces: 1, input: input(fs.map((f) => ({ ...f, entities: [e1] }))) })).clusters.filter((c) => c.axes.includes("shared_entity")).flatMap((c) => c.angles))].sort();
  assert.deepEqual(await angles([fact({ pk: "a", role: "ratchet", due: day(5) }), fact({ pk: "b", role: "capacity", surface: "operations" })]), ["mandate_vs_capacity"]);
  assert.deepEqual(await angles([fact({ pk: "a", role: "trigger", due: day(50), item: "a" }), fact({ pk: "b", role: "series", surface: "market", qty: 1 })]), ["lead_lag"]);
  assert.deepEqual(await angles([fact({ pk: "a", role: "ratchet", item: "a", due: day(5) }), fact({ pk: "b", role: "ceiling", item: "b", qty: 1 })]), ["regulatory_stacking"]);
  assert.deepEqual(await angles([fact({ pk: "a", role: "claim" })]), [], "a lone claim is read from no angle");
});

test("ranking and truncation: clusters rank by surface count then rows; the clusters beyond the limit and the rows beyond maxRows are counted, never dropped silently; rows are cut evenly across fronts", async () => {
  const uco = E("feed:uco");
  const many = Array.from({ length: 30 }, (_, n) => fact({ table: "market_series", pk: `m${String(n).padStart(2, "0")}`, role: "series", entities: [uco], at: day(-n), surface: "market", qty: 1, unit: "x" }));
  const facts = [...many, fact({ table: "oem_tech_roadmaps", pk: "r1", role: "capacity", entities: [uco], surface: "operations", due: day(300) }), fact({ table: "obligation_objects", pk: "o1", role: "ratchet", entities: [uco], surface: "regulations", due: day(100), item: "i1" })];
  const out = await assembleClusters(db, { limit: 1, input: input(facts), maxRows: 5 });
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0]?.surfaces, ["market", "operations", "regulations"], "three fronts survive the cap");
  assert.equal(out.clusters[0]?.rows.length, 5);
  assert.ok(out.truncated >= 27, "the 27 rows cut from the cluster are counted");
  const again = await assembleClusters(db, { limit: 1, input: input(facts), maxRows: 5 });
  assert.equal(again.clusters[0]?.id, out.clusters[0]?.id, "the id is a function of the rows");
});
