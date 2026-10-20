// The impact score method (IMPACT-1, INV-IMP-2 and INV-IMP-3): impact_scores@1.0.0 is pure, its output on a fixture item equals the rules table's expected scores, and a dimension whose input has not been read is NULL with the input named, never 0.
import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreImpact, type ImpactInput, type ImpactObject } from "@/core/impact/score";
import { createMethodRegistry } from "@/core/propagation";

const TODAY = "2026-10-15";
const object = (id: string, over: Partial<ImpactObject> = {}): ImpactObject => ({ obligation_id: id, binding_position: "direct_duty", duty_holder_class: ["shipper"], entry_into_force: null, date_of_application: null, first_deadline: null, sanction_class: null, statutory_maximum: null, direct_compliance_cost: null, ...over });
const input = (over: Partial<Omit<ImpactInput, "item">> & { item?: Partial<ImpactInput["item"]> } = {}): ImpactInput => ({
  today: TODAY, examined: true, objects: [], computations: [], sourceTier: 1, floorTier: 2,
  holderRoles: { carrier: ["carrier"], forwarder: ["forwarder"], nvocc: ["forwarder"], shipper: ["shipper"], member_state: [] },
  ...over, item: { transport_modes: [], operational_scenario_tags: [], cost_mechanism: null, penalty_range: null, ...over.item },
});
const dims = (i: ImpactInput) => {
  const s = scoreImpact(i);
  return [s.compliance, s.cost, s.operational];
};

test("INV-IMP-2 compliance: 0 no duty stated in a source that was read, 1 every duty non-binding, 2 a binding duty with no date inside 365 days, 3 a binding duty in force or due inside 365 days", () => {
  assert.deepEqual(dims(input()), [0, 0, 0]);
  assert.equal(dims(input({ objects: [object("a", { binding_position: "monitoring_only" })] }))[0], 1);
  assert.equal(dims(input({ objects: [object("a", { binding_position: "monitoring_only", first_deadline: "2026-11-01" }), object("b", { binding_position: "monitoring_only" })] }))[0], 1, "a non-binding duty is never more than 1, however near its date");
  assert.equal(dims(input({ objects: [object("a")] }))[0], 2, "binding, no date stated");
  assert.equal(dims(input({ objects: [object("a", { first_deadline: "2028-01-01", date_of_application: "2029-01-01" })] }))[0], 2, "binding, dates beyond the horizon");
  assert.equal(dims(input({ objects: [object("a", { first_deadline: "2027-10-15" })] }))[0], 3, "due exactly 365 days out");
  assert.equal(dims(input({ objects: [object("a", { first_deadline: "2027-10-16" })] }))[0], 2, "366 days out");
  assert.equal(dims(input({ objects: [object("a", { date_of_application: "2026-01-01" })] }))[0], 3, "applies already");
  assert.equal(dims(input({ objects: [object("a", { entry_into_force: "2026-01-01", first_deadline: "2029-01-01" })] }))[0], 3, "in force");
  assert.equal(dims(input({ objects: [object("a", { entry_into_force: "2027-01-01" })] }))[0], 2, "not yet in force and no date inside the horizon");
  assert.equal(dims(input({ objects: [object("a", { binding_position: "monitoring_only", first_deadline: "2026-11-01" }), object("b", { first_deadline: "2026-12-01" })] }))[0], 3, "one binding duty due soon among several");
  const s = scoreImpact(input({ objects: [object("a", { binding_position: "monitoring_only" }), object("b", { first_deadline: "2026-12-01" })] }));
  assert.deepEqual(s.basis.compliance, { obligations: ["a", "b"], binding: ["b"], due: ["b"], horizon: "2027-10-15" }, "the basis names the obligations it was computed from");
});

test("INV-IMP-2 cost: 1 a mechanism or a sanction class with no figure, 2 a figure from a source below the type's floor, 3 a figure from a source at or above it", () => {
  assert.equal(dims(input({ item: { cost_mechanism: "Per-litre shortfall multiplier" } }))[1], 1);
  assert.equal(dims(input({ objects: [object("a", { sanction_class: "administrative_fine" })] }))[1], 1);
  assert.equal(dims(input({ item: { penalty_range: "up to EUR 50 000" } }))[1], 3, "tier 1 against a floor of 2");
  assert.equal(dims(input({ item: { penalty_range: "up to EUR 50 000" }, sourceTier: 2 }))[1], 3, "at the floor");
  assert.equal(dims(input({ item: { penalty_range: "up to EUR 50 000" }, sourceTier: 3 }))[1], 2, "below the floor");
  assert.equal(dims(input({ item: { penalty_range: "up to EUR 50 000" }, sourceTier: null }))[1], 2, "an unrated source is not shown to meet the floor");
  assert.equal(dims(input({ item: { penalty_range: "up to EUR 50 000" }, sourceTier: 5, floorTier: null }))[1], 3, "a type with no authority floor needs no more than a rated source");
  assert.equal(dims(input({ objects: [object("a", { statutory_maximum: "EUR 2 million" })] }))[1], 3);
  assert.equal(dims(input({ objects: [object("a", { direct_compliance_cost: { amount: 5, currency: "EUR", basis: "per voyage", source: "x" } })] }))[1], 3);
  assert.equal(dims(input({ objects: [object("a")], computations: ["c1"] }))[1], 3, "a statutory computation is a figure");
  assert.equal(dims(input({ item: { cost_mechanism: "x", penalty_range: "y" } }))[1], 3, "a figure outranks a mechanism");
  assert.deepEqual(scoreImpact(input({ objects: [object("a", { statutory_maximum: "EUR 2 million" })], item: { penalty_range: "p" }, computations: ["c1"] })).basis.cost.figures, ["obligation_objects.statutory_maximum:a", "intelligence_items.penalty_range", "statutory_computations:c1"], "the basis names the column or computation of each figure");
});

test("INV-IMP-2 operational: the modes and scenario tags counted together (1, 2, 3 or more), 3 also when a duty names a forwarder or a carrier", () => {
  assert.equal(dims(input({ item: { transport_modes: ["ocean"] } }))[2], 1);
  assert.equal(dims(input({ item: { operational_scenario_tags: ["dangerous-goods"] } }))[2], 1);
  assert.equal(dims(input({ item: { transport_modes: ["ocean"], operational_scenario_tags: ["dangerous-goods"] } }))[2], 2);
  assert.equal(dims(input({ item: { transport_modes: ["ocean", "air"], operational_scenario_tags: ["dangerous-goods"] } }))[2], 3);
  assert.equal(dims(input({ item: { transport_modes: ["ocean", "air", "road", "rail"], operational_scenario_tags: ["a", "b"] } }))[2], 3, "never more than 3");
  assert.equal(dims(input({ item: { transport_modes: ["ocean"], operational_scenario_tags: ["ocean"] } }))[2], 1, "the same word as a mode and a tag counts once");
  assert.equal(dims(input({ objects: [object("a", { duty_holder_class: ["forwarder"] })] }))[2], 3, "a duty on the forwarder");
  assert.equal(dims(input({ objects: [object("a", { duty_holder_class: ["nvocc"] })] }))[2], 3, "a class the vocabulary maps to the forwarder role");
  assert.equal(dims(input({ objects: [object("a", { duty_holder_class: ["carrier"] })] }))[2], 3, "a duty on the carrier");
  assert.equal(dims(input({ objects: [object("a", { duty_holder_class: ["shipper"] }), object("b", { duty_holder_class: ["member_state"] })] }))[2], 0, "duties on others and nothing else");
});

test("INV-IMP-3: a dimension whose input has not been read is NULL and the score names the missing input; a dimension read and found empty is 0; NULL is never 0", () => {
  const unread = scoreImpact(input({ examined: false }));
  assert.deepEqual([unread.compliance, unread.cost, unread.operational, unread.missing], [null, null, null, ["obligations", "cost", "operational"]]);
  const read = scoreImpact(input({ examined: true }));
  assert.deepEqual([read.compliance, read.cost, read.operational, read.missing], [0, 0, 0, []]);
  const partly = scoreImpact(input({ examined: false, item: { cost_mechanism: "A mechanism", transport_modes: ["ocean"] } }));
  assert.deepEqual([partly.compliance, partly.cost, partly.operational, partly.missing], [null, 1, 1, ["obligations"]], "what the item does hold scores; only the unread input is missing");
  for (const s of [unread, read, partly]) for (const [k, v] of [["obligations", s.compliance], ["cost", s.cost], ["operational", s.operational]] as const) assert.equal(s.missing.includes(k), v === null, `${k}: NULL exactly when it is named`);
});

test("INV-IMP-2: the method is pure and registered under its version: the same input gives the same score without touching the input, and the registry holds impact_scores@1.0.0", () => {
  const i = input({ objects: [object("a", { first_deadline: "2026-12-01" })], item: { transport_modes: ["ocean"], cost_mechanism: "m" } });
  const before = JSON.stringify(i);
  assert.deepEqual(scoreImpact(i), scoreImpact(i));
  assert.equal(JSON.stringify(i), before);
  const registry = createMethodRegistry();
  assert.equal(registry.get("item_impact_scores", "impact_scores", "1.0.0"), scoreImpact);
  assert.deepEqual(registry.keys("item_impact_scores"), ["impact_scores@1.0.0"]);
  assert.throws(() => registry.register("item_impact_scores", "impact_scores", "1.0.0", scoreImpact), /already registered/);
});
