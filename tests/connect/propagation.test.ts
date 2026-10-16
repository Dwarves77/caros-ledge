// Propagation: admissibleFor's six refusals, the method registry, the drain (spec 08 section 7 assertion 2 on a fake client), the first-inference
// edges (B-0829) and the signpost transition table against migration 0013.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveInputs } from "@/core/propagation";
import { admissibleFor, createMethodRegistry, effectiveConfidence, FLOOR, buildFirstInferenceInput, nextLifecycleState, registerMarketMethods, runPropagationDrain, evaluateSignpostPredicate, fireSignpost } from "@/core/propagation";
import type { Lifecycle, Value } from "@/core/propagation";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-15T00:00:00Z");
const value = (over: Partial<Value> = {}): Value => ({
  valueId: "v", entityId: null, methodId: "m", methodVersion: "1", value: 1, valueLow: null, valueHigh: null, unit: null, currency: null, derivation: "calculated", originClass: "derived",
  lifecycle: "verified", admissibility: "calculation_ok", baseConfidence: 0.95, assertedAt: NOW.toISOString(), halfLifeDays: null, inputs: [], supersedes: null, computedAt: NOW.toISOString(), computedBy: "t", ...over,
});

test("admissibleFor: the six refusals, each from a value that is otherwise admissible", () => {
  assert.equal(admissibleFor(value(), "filing", NOW).ok, true);
  const refused = (v: Partial<Value>, use: "display" | "analysis" | "calculation" | "filing", why: RegExp) => {
    const r = admissibleFor(value(v), use, NOW);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, why);
  };
  refused({ lifecycle: "falsified" }, "display", /lifecycle/);
  refused({ lifecycle: "obsolete" }, "display", /lifecycle/);
  refused({ admissibility: "stale" }, "display", /pending recompute/);
  refused({ originClass: "community" }, "calculation", /community/);
  refused({ originClass: "community-corroborated" }, "filing", /community/);
  refused({ obsStatus: "M" } as Partial<Value>, "calculation", /missing/);
  refused({ derivation: "modelled" }, "filing", /non-contractable/);
  refused({ baseConfidence: 0.8 }, "filing", /decayed below floor/);
  refused({ baseConfidence: 0.7 }, "calculation", /decayed below floor/);
  refused({ baseConfidence: 0.4 }, "analysis", /decayed below floor/);
  assert.equal(admissibleFor(value({ originClass: "community", baseConfidence: 0.1 }), "display", NOW).ok, true, "display has no floor and no community rule");
  assert.deepEqual(FLOOR, { analysis: 0.5, calculation: 0.75, filing: 0.9 });
});

test("effectiveConfidence halves per half-life and refuses a bad input", () => {
  assert.equal(effectiveConfidence(0.8, "2026-10-01T00:00:00Z", 14, NOW.toISOString()), 0.4);
  assert.throws(() => effectiveConfidence(Number.NaN, NOW, null, NOW), TypeError);
  assert.throws(() => effectiveConfidence(1, NOW, 0, NOW), TypeError);
});

test("the method registry never overwrites a registration", () => {
  const r = createMethodRegistry();
  registerMarketMethods(r, { carbonIntensity: () => ({ ok: false, reason: "x" }), computeSeriesDeltas: () => ({}) });
  assert.throws(() => registerMarketMethods(r, { carbonIntensity: () => ({ ok: false, reason: "x" }), computeSeriesDeltas: () => ({}) }), /already registered/);
  assert.ok(r.has("derived_values", "carbon_intensity_tkm", "1.0.0"));
  assert.ok(r.has("inference_records", "infer-from-question", "v1"));
});

type Row = Record<string, unknown>;
/** A fake whose RPCs behave like the real ones for the rows this test holds: invalidate_dependents marks dependents stale, register_derived_value supersedes. */
function propagationWorld() {
  let seq = 0;
  // eslint-disable-next-line prefer-const
  let m: ReturnType<typeof memoryDb>;
  const rpc = (name: string, a: unknown) => {
    const args = a as Row;
    const t = m.tables;
    if (name === "invalidate_dependents") {
      const edges = (t.derivation_edges ?? []).filter((e) => e.from_table === args.p_table && e.from_pk === args.p_pk && e.to_table === "derived_values");
      const hit = (t.derived_values ?? []).filter((v) => edges.some((e) => e.to_value_id === v.value_id) && v.admissibility !== "stale" && v.superseded_by == null);
      if (args.p_apply) for (const v of hit) Object.assign(v, { admissibility: "stale", invalidated_by_event: args.p_event });
      return { data: hit.length };
    }
    if (name === "register_derived_value") {
      const id = `new-${++seq}`;
      (t.derived_values ??= []).push({ value_id: id, method_id: args.p_method_id, method_version: args.p_method_version, value: args.p_value, admissibility: args.p_admissibility, supersedes: args.p_supersedes, inputs: args.p_inputs, entity_id: args.p_entity_id });
      const old = (t.derived_values ?? []).find((v) => v.value_id === args.p_supersedes);
      if (old) old.superseded_by = id;
      for (const ref of args.p_inputs as { table: string; pk: string }[]) (t.derivation_edges ??= []).push({ from_table: ref.table, from_pk: ref.pk, to_table: "derived_values", to_value_id: id });
      return { data: id };
    }
    return { data: null };
  };
  const input = (table: string, pk: string) => ({ table, pk });
  const dv = (id: string, inputs: ReturnType<typeof input>[]) => ({ value_id: id, entity_id: null, method_id: "carbon_intensity_tkm", method_version: "1.0.0", value: 1, admissibility: "calculation_ok", unit: "g", currency: null, inputs, superseded_by: null });
  m = memoryDb({
    emission_factors: [{ factor_id: "F1", ttw_co2e: 10, source_key: "s", origin_class: "official", pedigree: 1 }, { factor_id: "F2", ttw_co2e: 20, source_key: "s", origin_class: "official", pedigree: 1 }],
    derived_values: [dv("D1", [input("emission_factors", "F1")]), dv("D2", [input("emission_factors", "F1")]), dv("D3", [input("emission_factors", "F2")])],
    derivation_edges: [
      { from_table: "emission_factors", from_pk: "F1", to_table: "derived_values", to_value_id: "D1" },
      { from_table: "emission_factors", from_pk: "F1", to_table: "derived_values", to_value_id: "D2" },
      { from_table: "emission_factors", from_pk: "F2", to_table: "derived_values", to_value_id: "D3" },
    ],
    propagation_events: [{ event_id: 1, table_name: "emission_factors", row_pk: "F1", entity_id: null, change_kind: "update", occurred_at: "2026-10-14T00:00:00Z", drained_at: null, new_row: null }],
  }, { rpc });
  const registry = createMethodRegistry();
  registerMarketMethods(registry, { carbonIntensity: (f) => ({ ok: true, valueGPerUnit: (f.ttw_co2e ?? 0) * 2, unit: "g/tkm" }), computeSeriesDeltas: () => ({}) });
  return { m, registry };
}

test("spec 08 section 7 assertion 2: revise one factor; every dependent goes stale; apply supersedes each; nothing else moves", async () => {
  const { m, registry } = propagationWorld();
  const dvs = () => m.tables.derived_values as Row[];
  const snapshotOther = JSON.stringify(dvs().find((v) => v.value_id === "D3"));

  const dry = await runPropagationDrain({ sb: m.db, now: () => NOW, registry }, { dry: true, caller: "test" });
  assert.equal(dry.outcome, "ok");
  assert.equal(dry.data?.invalidated, 2, "a dry run counts the dependents");
  assert.ok(dvs().every((v) => v.admissibility !== "stale"), "a dry run writes nothing");
  assert.equal((m.tables.propagation_events as Row[])[0]?.drained_at, null);

  const run = await runPropagationDrain({ sb: m.db, now: () => NOW, registry }, { dry: false, caller: "test" });
  assert.equal(run.outcome, "ok");
  assert.equal(run.data?.recomputed, 2);
  assert.equal(run.data?.eventsDrained, 1);
  assert.deepEqual(run.data?.superseded.map((s) => s.from).sort(), ["D1", "D2"]);
  for (const id of ["D1", "D2"]) {
    const old = dvs().find((v) => v.value_id === id);
    assert.equal(old?.admissibility, "stale", "the stale row is retained, never overwritten");
    const next = dvs().find((v) => v.value_id === old?.superseded_by);
    assert.equal(next?.supersedes, id);
    assert.equal(next?.value, 20);
  }
  assert.equal(JSON.stringify(dvs().find((v) => v.value_id === "D3")), snapshotOther, "an unrelated dependent does not move");
  assert.equal(dvs().length, 5);
  const again = await runPropagationDrain({ sb: m.db, now: () => NOW, registry }, { dry: false, caller: "test" });
  assert.equal(again.data?.eventsConsidered, 0, "a drained event is not drained twice");
});

test("a value whose method is not registered stays stale, counted", async () => {
  const { m } = propagationWorld();
  const run = await runPropagationDrain({ sb: m.db, now: () => NOW, registry: createMethodRegistry() }, { dry: false, caller: "test" });
  assert.equal(run.data?.skippedUnknownMethod, 2);
  assert.equal(run.data?.recomputed, 0);
  assert.equal((m.tables.derived_values as Row[]).filter((v) => v.admissibility === "stale").length, 2);
});

test("a failed queue read is reported, never read as an empty queue", async () => {
  const { m, registry } = propagationWorld();
  const bad = memoryDb({}, { failures: [{ table: "propagation_events", op: "select", message: "down" }] });
  const run = await runPropagationDrain({ sb: bad.db, now: () => NOW, registry }, { dry: true, caller: "test" });
  assert.notEqual(run.outcome, "ok");
  assert.ok(run.notes.join(" ").includes("down"));
  assert.ok(m);
});

test("a first inference declares the items it cites as its inputs (B-0829)", () => {
  const input = buildFirstInferenceInput({ subjectId: null, claimText: "c", statusToken: "HYPOTHESIS", confidence: 0.5, citedItemIds: ["i1", "i2"], triggerQuestionRef: "q", batch: "b1" } as never);
  assert.deepEqual((input.inputs ?? []).map((i) => `${i.table}/${i.pk}`).sort(), ["intelligence_items/i1", "intelligence_items/i2"]);
});

test("signpost transition table: the TypeScript function equals the 24 VALUES rows of migration 0013", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0013_fire_signpost.sql", import.meta.url), "utf8");
  const rows = [...sql.matchAll(/\('([a-z]+)', '(confirms|refutes|delays)', '([a-z]+)'\)/g)];
  assert.equal(rows.length, 24);
  for (const [, cur, dir, next] of rows) assert.equal(nextLifecycleState(cur as Lifecycle, dir as "confirms"), next, `${cur} on ${dir}`);
});

test("signpost predicates fire only on a resolvable, well-typed row", () => {
  assert.equal(evaluateSignpostPredicate({ op: "date_passed", field: "d" }, { d: "2026-01-01" }, NOW).fired, true);
  assert.equal(evaluateSignpostPredicate({ op: "date_passed", field: "d" }, { d: "2027-01-01" }, NOW).fired, false);
  assert.equal(evaluateSignpostPredicate({ op: "date_passed", field: "d" }, null, NOW).fired, false);
  assert.equal(evaluateSignpostPredicate({ op: "threshold", metric: "m", gte: 3 }, { m: "3" }, NOW).fired, false);
  assert.equal(evaluateSignpostPredicate({ op: "count_gte", relation: "x", n: 2 }, { x_count: 2 }, NOW).fired, true);
});

test("fireSignpost throws on an RPC error and on an empty result", async () => {
  const bad = memoryDb({}, { rpc: () => ({ error: { message: "no signpost" } }) });
  await assert.rejects(() => fireSignpost(bad.db, { signpostEntityId: "s", now: NOW }), /no signpost/);
  const empty = memoryDb({}, { rpc: () => ({ data: {} }) });
  await assert.rejects(() => fireSignpost(empty.db, { signpostEntityId: "s", now: NOW }), /returned no result/);
  const ok = memoryDb({}, { rpc: () => ({ data: { fired: true, first_firing: true, signpost_entity_id: "s", previous_lifecycle_state: "emerging", new_lifecycle_state: "strengthening" } }) });
  assert.equal((await fireSignpost(ok.db, { signpostEntityId: "s", now: NOW })).newLifecycleState, "strengthening");
});

test("resolveInputs: a failed read throws; a missing row is a null row", async () => {
  const bad = memoryDb({}, { failures: [{ table: "emission_factors", op: "select", message: "down" }] });
  await assert.rejects(() => resolveInputs(bad.db, [{ table: "emission_factors", pk: "F1" }]), /down/);
  const empty = memoryDb({ emission_factors: [] });
  assert.equal((await resolveInputs(empty.db, [{ table: "emission_factors", pk: "F1" }]))[0]?.row, null);
});
