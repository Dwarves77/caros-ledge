// DERIVE-3 D4: the penalty slot and the Penalties section read the penalty objects and the statutory schedule joined to them on obligation_id. INV-D3-6: the slot and the section model carry ids, column values, the data file's sanction labels and the slot
// labels, and no connective word of their own (the walker names a planted template sentence).
import assert from "node:assert/strict";
import { test } from "node:test";

import classes from "@/features/obligations/derive/data/sanction-classes.json" with { type: "json" };
import { fetchObligationObjectsForItem, summariseObligationBinding } from "@/core/workspace/relevance";

import { relevanceDeps } from "./_deps.ts";
import { clientFor, ITEM_1, seed } from "./_world.ts";

const PENALTY = "cl:obligation:79224588caec7af1";
const OBJECTS = [
  { obligation_id: PENALTY, version: 1, supersedes: null, pinpoint_citation: "Annex IV Part B", binding_position: "direct_duty", duty_holder_class: ["forwarder"], applicability_trigger: { attribute: "org_role", value: "forwarder" }, sanction_class: "monetary_per_unit", enforcement_start: "2025-01-01", statutory_maximum: "2 400 8. Is the amount to be paid in EUR per equivalent metric ton of VLSFO", cost_formula: null },
  { obligation_id: "cl:obligation:0000000000000009", version: 1, supersedes: null, pinpoint_citation: "Article 4", binding_position: "direct_duty", duty_holder_class: ["forwarder"], applicability_trigger: { attribute: "org_role", value: "forwarder" }, sanction_class: null, statutory_maximum: null, cost_formula: null },
];
const COMPUTATIONS = [
  { obligation_id: PENALTY, scenario_key: "eur_per_t_vlsfoe", result: 2400, result_unit: "EUR per equivalent metric ton of VLSFO" },
  { obligation_id: PENALTY, scenario_key: "berth_non_compliance", result: 1.5, result_unit: "EUR" },
  { obligation_id: "cl:obligation:0000000000000009", scenario_key: "share", result: 0.4, result_unit: "share" },
];
const withComputations = OBJECTS.map((o) => ({ ...o, computations: COMPUTATIONS.filter((c) => c.obligation_id === o.obligation_id) }));
const PROFILE = { orgRoles: ["forwarder"], orgSize: { headcount_band: null, revenue_band: null, shipment_volume_band: null } };

test("D4: fetchObligationObjectsForItem reads the sanction class and the statutory schedule rows joined to each object on obligation_id", async () => {
  const db = seed();
  db.rows("obligation_objects").push(...OBJECTS.map((o) => ({ ...o, instrument_item_id: ITEM_1 })));
  db.rows("statutory_computations").push(...COMPUTATIONS);
  const read = await fetchObligationObjectsForItem(clientFor(db), ITEM_1);
  const penalty = read.find((o) => o.obligation_id === PENALTY);
  assert.equal(penalty?.sanction_class, "monetary_per_unit");
  assert.deepEqual(penalty?.computations?.map((c) => c.scenario_key), ["berth_non_compliance", "eur_per_t_vlsfoe"]);
  assert.deepEqual(read.find((o) => o.obligation_id !== PENALTY)?.computations?.map((c) => c.scenario_key), ["share"]);
  db.fail("statutory_computations", "select", { message: "down" });
  await assert.rejects(fetchObligationObjectsForItem(clientFor(db), ITEM_1), /down/, "a failed schedule read is a failed load, not an object without its schedule");
});

test("D4: the penalty slot adds the sanction label and the schedule rows as columns; an object without a penalty field adds nothing and an empty slot is omitted", () => {
  const out = summariseObligationBinding(withComputations, PROFILE, relevanceDeps);
  const slot = out.lines[0]?.costSlots.find((s) => s.slot === "penalty_exposure");
  assert.deepEqual(slot?.entries, ["Monetary penalty per unit", "2 400 8. Is the amount to be paid in EUR per equivalent metric ton of VLSFO", "2400 EUR per equivalent metric ton of VLSFO", "1.5 EUR"]);
  assert.deepEqual(summariseObligationBinding([withComputations[1]], PROFILE, relevanceDeps).lines[0]?.costSlots, [], "a schedule row of a non-penalty object is not penalty exposure, and nothing is rendered empty");
  assert.deepEqual(out.penalties.map((p) => [p.pinpoint, p.sanction, p.start, p.basis]), [["Annex IV Part B", "Monetary penalty per unit", "2025-01-01", ["2400 EUR per equivalent metric ton of VLSFO", "1.5 EUR"]]], "the Penalties section model: penalty objects only");
  assert.deepEqual(summariseObligationBinding([withComputations[1]], PROFILE, relevanceDeps).penalties, [], "no penalty object: the section falls back to the brief's fields");
});

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+(?:[.,][0-9]+)?/g) ?? [];
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
  return out;
}
/** The words of an output that no input column value, data-file label or slot label supplies. */
const strangers = (output: unknown, input: unknown, labels: readonly string[]): string[] => {
  const allowed = new Set([...leaves(input), ...labels, ...leaves(input).map(String)].flatMap(words));
  for (const o of (input as Array<Record<string, unknown>>)) for (const v of Object.values(o)) if (typeof v === "number") allowed.add(String(v));
  return [...new Set(leaves(output).flatMap(words).filter((w) => !allowed.has(w)))];
};

test("INV-D3-6: the slot and the Penalties section model carry column values, labels and ids only; the walker names a planted template sentence", () => {
  const out = summariseObligationBinding(withComputations, PROFILE, relevanceDeps);
  const labels = ["Penalty exposure", "Direct compliance cost", "Effort (person-days, not money)", "Formula", ...classes.classes.map((c) => c.label), ...Object.values(relevanceDeps.sanctionLabels)];
  const input = withComputations.map((o) => ({ ...o, computations: o.computations.map((c) => ({ ...c, joined: `${c.result} ${c.result_unit}` })) }));
  assert.deepEqual(strangers([out.lines.map((l) => l.costSlots), out.penalties], input, labels), []);
  assert.deepEqual(strangers(["Exposure of up to 2400 EUR applies to carriers"], input, labels), ["up", "applies", "carriers"]);
});
