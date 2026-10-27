// CONNECT-2 C3: the five detectors as pure functions over facts. Each is run over empty input (no pattern, no error), over the case that is a pattern, and over the near miss that is not (a threshold from data/patterns.json crossed the wrong way); the numbers asserted are the arithmetic of the planted facts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { COUPLING_RELATIONS, couplingByKey, type Relation } from "@/core/coupling";
import { DETECTORS, factOf, PATTERNS, type Fact, type PatternInput } from "@/core/flywheel/patterns";

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
  const burst = [3, 7, 12].map((ago, n) => fact({ pk: `m${n}`, at: day(-ago), docAt: day(-ago), source: `s${n}`, tier: n + 1 }));
  const baseline = [100, 101, 102].map((ago, n) => fact({ pk: `b${n}`, at: day(-ago), docAt: day(-ago), source: `s${n + 9}`, tier: 1 }));
  const flow = new Map([[day(-5), 2], [day(-3), 1], [day(-7), 1], [day(-12), 1], [day(-100), 30]]);
  const found = DETECTORS.velocity(input([...burst, ...baseline], { flow }));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.key, "e1|30");
  assert.ok(Math.abs((found[0]?.value ?? 0) - 6) < 1e-9, "3 of 5 claims in the window against 3 of 30 before is six times the baseline share");
  assert.deepEqual(found[0]?.evidence.map((e) => e.kind).sort(), ["key", "member", "member", "member"], "the baseline is one summary edge");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline], { flow: null })), [], "no flow, no baseline");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline], { flow: new Map([[day(-5), 10]]) })), [], "a baseline window the corpus held no claims in defines none");
  assert.deepEqual(DETECTORS.velocity(input(burst, { flow })), [], "an entity with no earlier citations is new to the corpus: its first appearance is coverage, not velocity");
  assert.deepEqual(DETECTORS.velocity(input([...burst.slice(0, 2), ...baseline], { flow })), [], "two sources are not three");
  assert.deepEqual(DETECTORS.velocity(input([...burst.map((f) => ({ ...f, source: "s0" })), ...baseline], { flow })), [], "one source cited three times is one source");
  assert.deepEqual(DETECTORS.velocity(input([...burst.map((f) => ({ ...f, tier: 1, surface: "regulations" })), ...baseline], { flow })), [], "one tier on one surface is not convergence");
  const heavy = Array.from({ length: 18 }, (_, n) => fact({ pk: `h${n}`, at: day(-100 - n), docAt: day(-100 - n), source: `x${n}`, tier: 1 }));
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...heavy], { flow })), [], "the same share as before is not a burst: a growing corpus is not a burst of its entities");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline].map((f) => ({ ...f, kind: PATTERNS.velocity.excludeKinds[0] as string })), { flow })), [], "a claim of an excluded kind (an absence) is not a citation");
  assert.equal(DETECTORS.velocity(input([...burst, ...baseline], { flow: null, carry: 4.5 }))[0]?.value, 4.5, "a stored pattern is revalidated on its own members and keeps its value");
});

test("P1 caps its evidence in patterns.json: the most recent members and one summary edge carrying the counts and the baseline window", () => {
  const cap = PATTERNS.velocity.maxEvidence;
  assert.equal(cap, 50);
  const members = Array.from({ length: 120 }, (_, n) => fact({ pk: `m${String(n).padStart(3, "0")}`, at: day(-(n % 25)), docAt: day(-(n % 25)), source: `s${n % 7}`, tier: 1 + (n % 3) }));
  const baseline = [100, 101, 102, 103].map((ago, n) => fact({ pk: `b${n}`, at: day(-ago), docAt: day(-ago), source: `x${n}`, tier: 1 }));
  const found = DETECTORS.velocity(input([...members, ...baseline], { flow: new Map([[day(-5), 150], [day(-100), 400]]) }));
  assert.equal(found.length, 1);
  const edges = found[0]?.evidence ?? [];
  assert.equal(edges.filter((e) => e.kind === "member").length, cap, "no more than the cap");
  const summary = edges.filter((e) => e.kind === "key");
  assert.equal(summary.length, 1, "one summary edge, not the baseline claims");
  assert.deepEqual(summary[0]?.summary, { members: 120, baseline: 4, windowDays: 30, baselineDays: 180 });
  const kept = new Set(edges.filter((e) => e.kind === "member").map((e) => e.pk));
  const oldestKept = Math.min(...members.filter((m) => kept.has(m.pk)).map((m) => Date.parse(m.at as string)));
  assert.ok(members.filter((m) => !kept.has(m.pk)).every((m) => Date.parse(m.at as string) <= oldestKept), "the members kept are the most recent");
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

test("P1 clock (unified design section 3): the burst counts on the document date of the capture, never the day the item was added; an undated claim is in the window, the baseline and the flow of nothing", () => {
  const burst = [3, 7, 12].map((ago, n) => fact({ pk: `m${n}`, at: day(-ago), docAt: day(-ago), source: `s${n}`, tier: n + 1 }));
  const baseline = [100, 101, 102].map((ago, n) => fact({ pk: `b${n}`, at: day(-ago), docAt: day(-ago), source: `s${n + 9}`, tier: 1 }));
  const flow = new Map([[day(-5), 2], [day(-3), 1], [day(-7), 1], [day(-12), 1], [day(-100), 30]]);
  assert.equal(DETECTORS.velocity(input([...burst, ...baseline], { flow })).length, 1);
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline].map((f) => { const g = { ...f }; delete g.docAt; return g; }), { flow })), [], "item added dates alone make no burst");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline].map((f) => ({ ...f, docAt: null })), { flow })), [], "claims whose capture carries no document date are undated");
  assert.deepEqual(DETECTORS.velocity(input([...burst, ...baseline].map((f) => ({ ...f, at: day(-200) })), { flow })).map((p) => p.key), ["e1|30"], "the item's added date is not read: old items, recent documents");
  assert.deepEqual(DETECTORS.velocity(input([...burst.slice(0, 2), ...burst.slice(2).map((f) => ({ ...f, docAt: null })), ...baseline], { flow })), [], "an undated third source does not make the third source");
});

test("P4 starts from the entity a mandate is about, never from the mode or the hub it is filed under: a ratchet filed under mode:ocean alone fans out to nothing, the same ratchet under a carrier crosses (red without the exclusion: five patterns, three consignment_wide and two corridor_links)", () => {
  const ocean = (couplingByKey("mode:ocean") as { entityId: string }).entityId;
  const related = (e: string) => COUPLING_RELATIONS.flatMap((r) => { const [p, c] = [(couplingByKey(r.parent) as { entityId: string }).entityId, (couplingByKey(r.child) as { entityId: string }).entityId]; return p === e ? [{ entity: c, relation: r.relation }] : c === e ? [{ entity: p, relation: r.relation }] : []; });
  // a recent row under every entity one relation from the mode, so that each neighbour would be a landing
  const landings = related(ocean).map((l, n) => fact({ table: "section_claim_provenance", pk: `l${n}`, entities: [l.entity], at: day(-5) }));
  const ratchet = (entity: string) => fact({ table: "obligation_objects", pk: "r1", role: "ratchet", entities: [entity], due: day(1) });
  assert.ok(landings.length >= 6, "the mode has at least six neighbours");
  assert.deepEqual(DETECTORS.crossModal(input([ratchet(ocean), ...landings], { related })), [], "filed under the mode: no start");
  const hub = (couplingByKey("hub:seaport") as { entityId: string }).entityId;
  assert.deepEqual(DETECTORS.crossModal(input([ratchet(hub), ...related(hub).map((l, n) => fact({ pk: `h${n}`, entities: [l.entity], at: day(-5) }))], { related })), [], "filed under a hub: no start");
  const bunkers = (couplingByKey("carrier:bio_bunkers") as { entityId: string }).entityId;
  const saf = (couplingByKey("carrier:hefa_saf") as { entityId: string }).entityId;
  const found = DETECTORS.crossModal(input([ratchet(bunkers), fact({ pk: "l-saf", entities: [saf], at: day(-5) })], { related }));
  assert.deepEqual(found.map((p) => p.key), [`r1|competes_for_feedstock|${saf}`]);
});

test("an ended ceiling is no fact: a ceiling reads statutory_maximum only inside [enforcement_start, in_force_end] (the EUR 40 transitional ceiling of Regulation 2025/2083 Art 16(4), period ended 2007, matched P5 at ratio 31.25)", () => {
  const ceiling = (over: Record<string, unknown>) => factOf("obligation_objects", { obligation_id: "o1", statutory_maximum: "EUR 40 for each tonne of carbon dioxide equivalent", ...over }, ["e1"], { role: "ceiling", now: NOW });
  assert.deepEqual([ceiling({})?.qty, ceiling({})?.unit], [40, "EUR/tCO2e"], "no window: in force");
  assert.equal(ceiling({ enforcement_start: "2005-01-01", in_force_end: "2007-12-31" }), null, "the period ended");
  assert.equal(ceiling({ enforcement_start: "2027-01-01" }), null, "not yet in force");
  assert.equal(ceiling({ enforcement_start: "2005-01-01", in_force_end: day(0) })?.qty, 40, "the last day of the period is in force");
  assert.equal(ceiling({ in_force_end: day(-1) }), null, "ended yesterday");
  const tech: Fact = fact({ table: "research_assessments", pk: "t1", role: "tech", trl: 9 });
  const abate = fact({ table: "derived_values", pk: "a1", role: "abatement", qty: 1250, unit: "EUR/tCO2e" });
  const live = factOf("obligation_objects", { obligation_id: "o2", statutory_maximum: "EUR 100 for each tonne of carbon dioxide equivalent" }, ["e1"], { role: "ceiling", now: NOW }) as Fact;
  assert.deepEqual(DETECTORS.penaltyAbatement(input([tech, abate, live])).map((p) => p.value), [12.5], "only the ceiling in force matches");
});

test("the ratchet reads the mandated quantity, its unit and the due date, never the penalty maximum: a mandated MW is compared with a capacity in MW, a penalty is not a quantity to be met", () => {
  const row = { obligation_id: "o1", due_date: day(100), mandated_quantity: 3.6, mandated_unit: "MW", statutory_maximum: "EUR 100 for each tonne of carbon dioxide equivalent" };
  const ratchet = factOf("obligation_objects", row, ["e1"], { role: "ratchet", now: NOW }) as Fact;
  const queue = factOf("grid_connection_queues", { queue_id: "q1", as_of: day(-10), demand_available_mw: 1.2 }, ["e1"], { now: NOW }) as Fact;
  assert.deepEqual([ratchet.qty, ratchet.unit, queue.qty, queue.unit], [3.6, "MW", 1.2, "MW"]);
  const found = DETECTORS.mandateCapacity(input([ratchet, queue]));
  assert.deepEqual([found.length, found[0]?.unit, Number(found[0]?.value.toFixed(4))], [1, "ratio", 0.6667], "short by two thirds of what is mandated");
  assert.deepEqual(DETECTORS.penaltyAbatement(input([fact({ table: "research_assessments", pk: "t", role: "tech", trl: 9 }), fact({ table: "derived_values", pk: "a", role: "abatement", qty: 95, unit: "EUR/tCO2e" }), ratchet])), [], "a ratchet is no ceiling");
});

test("statutory_computations with a year scenario_key gain a due (HYPOTHESIS of TRIANGLE-TRACE Q2, tested before it was relied on): CONFIRMED that a step keyed 2030 becomes a dated ratchet P2 sees once it is inside the 36-month horizon, and not before; a key that is no year gives no ratchet", () => {
  const entity = (couplingByKey("instrument:32023R1805") as { entityId: string }).entityId;
  const step = (key: string) => factOf("statutory_computations", { computation_id: `c-${key}`, entity_id: entity, scenario_key: key, result: 2, result_unit: "pct", computed_at: "2026-10-01T00:00:00Z" }, [entity], { role: "ratchet", now: NOW });
  assert.deepEqual(["2030", "2035", "2040", "default", "30", "2030-q1"].map((k) => step(k)?.due ?? null), ["2030-01-01", "2035-01-01", "2040-01-01", null, null, null]);
  const capacity = fact({ table: "oem_tech_roadmaps", pk: "r1", role: "capacity", entities: ["capacity-entity"], due: "2032-01-01" });
  const related = links({ [entity]: [["capacity-entity", "implements"]] });
  const at = (iso: string) => DETECTORS.mandateCapacity({ now: new Date(`${iso}T12:00:00Z`), facts: [step("2030") as Fact, capacity], related, flow: null });
  assert.deepEqual(at("2026-10-15"), [], "2030-01-01 is 39 months out: beyond the horizon P2 reads");
  assert.deepEqual(at("2027-06-01").map((p) => [p.value, p.unit]), [[24, "months"]], "31 months out: inside it, and the capacity lands 24 months after the step");
});

test("G3: a ratchet's due date carries its stored precision: a year-precision mandate is a year fact, never a day; a day or an unrecorded precision carries none; a scenario year is a year", () => {
  const row = (over: Record<string, unknown>) => factOf("obligation_objects", { obligation_id: "o9", due_date: "2027-01-01", mandated_quantity: 5, mandated_unit: "MW", ...over }, ["e1"], { role: "ratchet", now: NOW }) as Fact;
  assert.equal(row({ due_date_precision: "year" }).duePrecision, "year");
  assert.equal(row({ due_date_precision: "month" }).duePrecision, "month");
  assert.equal(row({ due_date_precision: "day" }).duePrecision, undefined);
  assert.equal("duePrecision" in row({}), false);
  assert.equal(row({ due_date_precision: "year" }).due, "2027-01-01", "the stored date is unchanged: only its precision is carried");
  const scenario = factOf("statutory_computations", { computation_id: "c1", scenario_key: "2030", result: 3, result_unit: "MW" }, ["e1"], { role: "ratchet", now: NOW }) as Fact;
  assert.equal(scenario.duePrecision, "year");
});
