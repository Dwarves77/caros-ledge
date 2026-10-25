// CONNECT-2 C3: the five detectors as pure functions over facts. Each is run over empty input (no pattern, no error), over the case that is a pattern, and over the near miss that is not (a threshold from data/patterns.json crossed the wrong way); the numbers asserted are the arithmetic of the planted facts.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Relation } from "@/core/coupling";
import { DETECTORS, PATTERNS, type Fact, type PatternInput } from "@/core/flywheel/patterns";

import { E } from "./_world.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const day = (offset: number): string => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const fact = (over: Partial<Fact>): Fact => ({ table: "t", pk: "p", role: "claim", entities: ["e1"], modes: [], surface: "regulations", at: null, due: null, source: null, tier: null, qty: null, unit: null, trl: null, kind: "FACT", group: null, ...over });
const input = (facts: Fact[], over: Partial<PatternInput> = {}): PatternInput => ({ now: NOW, facts, related: () => [], flow: null, ...over });
const links = (map: Record<string, [string, Relation][]>) => (e: string) => (map[e] ?? []).map(([entity, relation]) => ({ entity, relation }));

test("every detector over no facts finds nothing and raises nothing", () => {
  for (const [kind, detect] of Object.entries(DETECTORS)) assert.deepEqual(detect(input([])), [], kind);
});

test("P1 velocity: three independent sources of two tiers in the window, at a larger share of the corpus flow than the entity held before; no flow and no earlier citations, no baseline; the near misses are not bursts", () => {
  const burst = [3, 7, 12].map((ago, n) => fact({ pk: `m${n}`, at: day(-ago), source: `s${n}`, tier: n + 1 }));
  const baseline = [100, 101, 102].map((ago, n) => fact({ pk: `b${n}`, at: day(-ago), source: `s${n + 9}`, tier: 1 }));
  const flow = new Map([[day(-5), 2], [day(-3), 1], [day(-7), 1], [day(-12), 1], [day(-100), 30]]);
  const found = DETECTORS.velocity(input([...burst, ...baseline], { flow }));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.key, "e1|30");
  assert.ok(Math.abs((found[0]?.value ?? 0) - 6) < 1e-9, "3 of 5 claims in the window against 3 of 30 before is six times the baseline share");
  assert.deepEqual(found[0]?.evidence.map((e) => e.kind).sort(), ["key", "key", "key", "member", "member", "member"]);
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline], { flow: null })), [], "no flow, no baseline");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline], { flow: new Map([[day(-5), 10]]) })), [], "a baseline window the corpus held no claims in defines none");
  assert.deepEqual(DETECTORS.velocity(input(burst, { flow })), [], "an entity with no earlier citations is new to the corpus: its first appearance is coverage, not velocity");
  assert.deepEqual(DETECTORS.velocity(input([...burst.slice(0, 2), ...baseline], { flow })), [], "two sources are not three");
  assert.deepEqual(DETECTORS.velocity(input([...burst.map((f) => ({ ...f, source: "s0" })), ...baseline], { flow })), [], "one source cited three times is one source");
  assert.deepEqual(DETECTORS.velocity(input([...burst.map((f) => ({ ...f, tier: 1, surface: "regulations" })), ...baseline], { flow })), [], "one tier on one surface is not convergence");
  const heavy = Array.from({ length: 18 }, (_, n) => fact({ pk: `h${n}`, at: day(-100 - n), source: `x${n}`, tier: 1 }));
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...heavy], { flow })), [], "the same share as before is not a burst: a growing corpus is not a burst of its entities");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline].map((f) => ({ ...f, kind: PATTERNS.velocity.excludeKinds[0] as string })), { flow })), [], "a claim of an excluded kind (an absence) is not a citation");
  assert.equal(DETECTORS.velocity(input([...burst, ...baseline], { flow: null, carry: 4.5 }))[0]?.value, 4.5, "a stored pattern is revalidated on its own members and keeps its value");
});

test("P2 mandate and capacity: the capacity lands after the ratchet, or holds less than it mandates in the same unit; a past ratchet, one beyond the horizon, a mismatched unit and an earlier capacity are not", () => {
  const rel = links({ ratchetEntity: [["capEntity", "implements"]], capEntity: [["ratchetEntity", "implements"]] });
  const r = (over: Partial<Fact> = {}) => fact({ table: "obligation_objects", pk: "r1", role: "ratchet", entities: ["ratchetEntity"], due: day(100), ...over });
  const c = (over: Partial<Fact> = {}) => fact({ table: "oem_tech_roadmaps", pk: "c1", role: "capacity", entities: ["capEntity"], ...over });
  const late = DETECTORS.mandateCapacity(input([r(), c({ due: day(100 + 700) })], { related: rel }));
  assert.equal(late.length, 1);
  assert.equal(late[0]?.unit, "months");
  assert.ok((late[0]?.value ?? 0) >= 22 && (late[0]?.value ?? 0) <= 24);
  assert.deepEqual(late[0]?.evidence.map((e) => [e.table, e.kind]), [["obligation_objects", "key"], ["oem_tech_roadmaps", "evidence"]]);
  const short = DETECTORS.mandateCapacity(input([r({ qty: 200, unit: "MW" }), c({ qty: 150, unit: "MW" })], { related: rel }));
  assert.deepEqual([short[0]?.unit, short[0]?.value], ["ratio", 0.25]);
  assert.deepEqual(DETECTORS.mandateCapacity(input([r({ qty: 200, unit: "MW" }), c({ qty: 150, unit: "t" })], { related: rel })), [], "no quantity is compared across units");
  assert.deepEqual(DETECTORS.mandateCapacity(input([r(), c({ due: day(50) })], { related: rel })), [], "capacity that lands first is no collision");
  assert.deepEqual(DETECTORS.mandateCapacity(input([r({ due: day(-5) }), c({ due: day(700) })], { related: rel })), [], "a ratchet already past");
  assert.deepEqual(DETECTORS.mandateCapacity(input([r({ due: day(365 * 5) }), c({ due: day(365 * 9) })], { related: rel })), [], "a ratchet beyond the widest window");
  assert.deepEqual(DETECTORS.mandateCapacity(input([r(), c({ due: day(800) })])), [], "no shared entity, no join");
});

test("P3 lead and lag: a trigger 60 to 180 days out and a move on a shared entity in the last 90 days; outside either bound it is not", () => {
  const trigger = (due: number, kind = "phase_step") => fact({ table: "item_forward_events", pk: "t1", role: "trigger", kind, due: day(due) });
  const move = (ago: number, qty = 0.2) => fact({ table: "market_series", pk: "m1", role: "series", at: day(-ago), qty, unit: "ratio", surface: "market" });
  const found = DETECTORS.leadLag(input([trigger(100), move(20)]));
  assert.equal(found.length, 1);
  assert.deepEqual([found[0]?.value, found[0]?.unit], [100, "days"]);
  assert.deepEqual(DETECTORS.leadLag(input([trigger(30), move(20)])), [], "too near");
  assert.deepEqual(DETECTORS.leadLag(input([trigger(400), move(20)])), [], "too far");
  assert.deepEqual(DETECTORS.leadLag(input([trigger(100), move(120)])), [], "the move is older than the window");
  assert.deepEqual(DETECTORS.leadLag(input([trigger(100), move(20, 0.01)])), [], "a move under the threshold is a tick");
  assert.deepEqual(DETECTORS.leadLag(input([trigger(100, "consultation_close"), move(20)])), [], "only the pending kinds");
  assert.deepEqual(DETECTORS.leadLag(input([trigger(100), { ...move(20), entities: ["other"] }])), [], "a move on another entity");
});

test("P4 cross-modal: a mandate or move in one mode entity and recent rows in a mode the relation carries it to; strength by relation and recency; a relation not crossed, no new mode and a stale row are not", () => {
  const air = E("carrier:hefa_saf");
  const road = E("carrier:hvo");
  const start = (over: Partial<Fact> = {}) => fact({ table: "market_series", pk: "m1", role: "series", entities: [road], at: day(-10), qty: 0.2, unit: "ratio", ...over });
  const landing = (over: Partial<Fact> = {}) => fact({ table: "section_claim_provenance", pk: "c1", role: "claim", entities: [air], at: day(-10), ...over });
  const found = DETECTORS.crossModal(input([start(), landing()], { related: links({ [road]: [[air, "competes_for_feedstock"]] }) }));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.key, `m1|competes_for_feedstock|${air}`);
  assert.ok(Math.abs((found[0]?.value ?? 0) - 0.8 * (1 - 10 / PATTERNS.crossModal.recencyDays)) < 1e-9);
  assert.deepEqual(found[0]?.evidence.map((e) => [e.kind, e.relation]), [["member", "competes_for_feedstock"], ["evidence", "competes_for_feedstock"]]);
  assert.deepEqual(DETECTORS.crossModal(input([start(), landing()], { related: links({ [road]: [[air, "implements"]] }) })), [], "a relation the detector does not cross");
  const bunkers = E("carrier:bio_bunkers");
  assert.deepEqual(DETECTORS.crossModal(input([start(), landing({ entities: [bunkers] })], { related: links({ [road]: [[bunkers, "competes_for_feedstock"]] }) })), [], "no mode the start entity lacks");
  assert.deepEqual(DETECTORS.crossModal(input([start(), landing({ at: day(-200) })], { related: links({ [road]: [[air, "competes_for_feedstock"]] }) })), [], "a landing row older than the window");
  assert.deepEqual(DETECTORS.crossModal(input([start({ at: day(-85) }), landing()], { related: links({ [road]: [[air, "corridor_links"]] }) })), [], "strength below the floor: a weak relation, a stale start");
});

test("P5 penalty and abatement: a technology at the maturity floor whose abatement cost crosses or comes within the band of a ceiling in the same unit; below the floor, outside the band and across units it is not", () => {
  const tech = (trl: number) => fact({ table: "research_assessments", pk: "t1", role: "tech", entities: ["e1"], trl });
  const abate = (qty: number, unit = "EUR/tCO2e") => fact({ table: "derived_values", pk: "a1", role: "abatement", entities: ["e1"], qty, unit });
  const ceiling = (qty: number, unit = "EUR/tCO2e") => fact({ table: "statutory_computations", pk: "k1", role: "ceiling", entities: ["e1"], qty, unit });
  const near = DETECTORS.penaltyAbatement(input([tech(8), abate(95), ceiling(100)]));
  assert.equal(near.length, 1);
  assert.ok(Math.abs((near[0]?.value ?? 0) - 0.95) < 1e-12);
  assert.equal(DETECTORS.penaltyAbatement(input([tech(9), abate(130), ceiling(100)]))[0]?.value, 1.3, "crossed");
  assert.deepEqual(DETECTORS.penaltyAbatement(input([tech(7), abate(95), ceiling(100)])), [], "below the maturity floor");
  assert.deepEqual(DETECTORS.penaltyAbatement(input([tech(8), abate(60), ceiling(100)])), [], "outside the band");
  assert.deepEqual(DETECTORS.penaltyAbatement(input([tech(8), abate(95), ceiling(100, "EUR/t")])), [], "across units");
});
