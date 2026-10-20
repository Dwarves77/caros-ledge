// R2d, I13 and I14 in the propagation core: inputs resolve through the admissible-row rule (flywheel:8), the inference method re-evaluates and never edits (flywheel:7), authoring is one statement (flywheel:32),
// and the seed op neither duplicates nor seeds a superseded factor (flywheel:10).
import assert from "node:assert/strict";
import { test } from "node:test";

import { authorEdges, createMethodRegistry, registerMarketMethods, resolveInputs, runPropagationDrain } from "@/core/propagation";
import { seedDerivedValues } from "@/features/propagation/ops/seed-derived-values";

import { installPropagationRpcs } from "../_support/memdb.ts";
import { memoryDb, type Row } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-19T00:00:00Z");
const ITEM = (id: string, over: Row = {}): Row => ({ id, title: id, domain: 1, provenance_status: "verified", is_archived: false, replaced_by: null, ...over });
const FACTOR = (id: string, over: Row = {}): Row => ({ factor_id: id, quantity_basis: "tkm", ttw_co2e: 10, wtw_co2e: null, wtt_co2e: null, source_key: "desnz_ghg_factors", origin_class: "official", pedigree: 1, superseded_by: null, ...over });

test("flywheel:8: an input that is not current resolves to a null row, per table; a current one resolves to itself", async () => {
  const m = memoryDb({
    emission_factors: [FACTOR("F-live"), FACTOR("F-old", { superseded_by: "F-live" })],
    intelligence_items: [ITEM("i-live"), ITEM("i-arch", { is_archived: true }), ITEM("i-unv", { provenance_status: "unverified" }), ITEM("i-rep", { replaced_by: "i-live" })],
    section_claim_provenance: [{ id: "c-live", intelligence_item_id: "i-live", claim_text: "kept" }, { id: "c-sup", intelligence_item_id: "i-live", claim_text: "wrong" }, { id: "c-gone", intelligence_item_id: "i-arch", claim_text: "orphan" }],
    item_corrections: [{ id: "k1", item_id: "i-live", target_kind: "fact", target_ref: "c-sup", op: "suppress", machine_value: { claim_text: "wrong" }, created_at: "2026-10-01T00:00:00Z", revoked_at: null }],
    derived_values: [{ value_id: "d-live", admissibility: "calculation_ok", lifecycle: "verified" }, { value_id: "d-stale", admissibility: "stale", lifecycle: "verified" }, { value_id: "d-sup", admissibility: "calculation_ok", lifecycle: "superseded" }],
    inference_records: [{ inference_id: "n-live", admissibility: "current" }, { inference_id: "n-old", admissibility: "current" }, { inference_id: "n-new", admissibility: "current", supersedes: "n-old" }],
  });
  const refs = [
    ["emission_factors", "F-live", true], ["emission_factors", "F-old", false],
    ["intelligence_items", "i-live", true], ["intelligence_items", "i-arch", false], ["intelligence_items", "i-unv", false], ["intelligence_items", "i-rep", false],
    ["section_claim_provenance", "c-live", true], ["section_claim_provenance", "c-sup", false], ["section_claim_provenance", "c-gone", false],
    ["derived_values", "d-live", true], ["derived_values", "d-stale", false], ["derived_values", "d-sup", false],
    ["inference_records", "n-live", true], ["inference_records", "n-old", false], ["inference_records", "n-new", true],
  ] as const;
  const out = await resolveInputs(m.db, refs.map(([table, pk]) => ({ table, pk })));
  refs.forEach(([table, pk, current], i) => assert.equal(out[i]?.row !== null, current, `${table}/${pk}`));
});

test("flywheel:8: a failed read of the item a claim belongs to, or of its suppressions, throws; it is never read as 'not current'", async () => {
  const claims = [{ id: "c1", intelligence_item_id: "i1", claim_text: "x" }];
  const noItem = memoryDb({ section_claim_provenance: claims, intelligence_items: [ITEM("i1")] }, { failures: [{ table: "intelligence_items", op: "select", message: "down" }] });
  await assert.rejects(() => resolveInputs(noItem.db, [{ table: "section_claim_provenance", pk: "c1" }]), /down/);
  const noCorrections = memoryDb({ section_claim_provenance: claims, intelligence_items: [ITEM("i1")] }, { failures: [{ table: "item_corrections", op: "select", message: "down" }] });
  await assert.rejects(() => resolveInputs(noCorrections.db, [{ table: "section_claim_provenance", pk: "c1" }]), /down/);
});

function inferenceWorld(over: { inference?: Row; items?: Row[] } = {}) {
  const m = memoryDb({
    intelligence_items: over.items ?? [ITEM("i1"), ITEM("i2")],
    inference_records: [{ inference_id: "n1", subject_id: null, claim_text: "Carriers will pass the cost through.", status_token: "HYPOTHESIS", confidence: 0.62, cited_item_ids: ["i1", "i2"], origin_class: "derived", trigger_question_ref: "i1:regulations:q", method_id: "infer-from-question", method_version: "v1", admissibility: "stale", invalidated_by_event: 1, ...over.inference }],
    derivation_edges: [{ from_table: "intelligence_items", from_pk: "i1", to_table: "inference_records", to_value_id: "n1" }, { from_table: "intelligence_items", from_pk: "i2", to_table: "inference_records", to_value_id: "n1" }],
    propagation_events: [{ event_id: 1, table_name: "intelligence_items", row_pk: "i1", entity_id: null, change_kind: "update", occurred_at: "2026-10-18T00:00:00Z", drained_at: null, new_row: null }],
  });
  installPropagationRpcs(m.mem);
  m.mem.rpcs.invalidate_dependents = () => ({ data: 1 });
  m.mem.rpcs.register_inference_record = (a, d) => {
    const id = `n${d.rows("inference_records").length + 1}`;
    d.rows("inference_records").push({ inference_id: id, subject_id: a.p_subject_id, claim_text: a.p_claim_text, status_token: a.p_status_token, confidence: a.p_confidence, cited_item_ids: a.p_cited_item_ids, origin_class: a.p_origin_class, method_id: a.p_method_id, method_version: a.p_method_version, admissibility: "current", supersedes: a.p_supersedes, trigger_question_ref: a.p_trigger_question_ref });
    return { data: id };
  };
  return m;
}
const successor = (m: ReturnType<typeof inferenceWorld>, of: string): Row => (m.tables.inference_records as Row[]).find((r) => r.supersedes === of) as Row;
const drain = (m: ReturnType<typeof inferenceWorld>) => runPropagationDrain({ sb: m.db, now: () => NOW, registry: createMethodRegistry() }, { dry: false, caller: "test" });

test("flywheel:7: every cited item still current, the successor carries the text, the token and the confidence over unchanged and is written as the current method version", async () => {
  const m = inferenceWorld();
  const run = await drain(m);
  assert.equal(run.data?.recomputed, 1);
  const next = successor(m, "n1");
  assert.equal(next.claim_text, "Carriers will pass the cost through.", "the prior text is never edited");
  assert.equal(next.confidence, 0.62, "no confidence is forced");
  assert.equal(next.status_token, "HYPOTHESIS");
  assert.equal(next.method_version, "v2");
  assert.deepEqual(next.cited_item_ids, ["i1", "i2"]);
});

test("flywheel:7: recomputing the successor again does not grow its text (the probe appended a suffix each time)", async () => {
  const m = inferenceWorld();
  await drain(m);
  const first = successor(m, "n1");
  Object.assign(first, { admissibility: "stale", invalidated_by_event: 2 });
  (m.tables.derivation_edges as Row[]).push(...["i1", "i2"].map((pk) => ({ from_table: "intelligence_items", from_pk: pk, to_table: "inference_records", to_value_id: first.inference_id })));
  (m.tables.propagation_events as Row[]).push({ event_id: 2, table_name: "intelligence_items", row_pk: "i1", entity_id: null, change_kind: "update", occurred_at: "2026-10-19T00:00:00Z", drained_at: null, new_row: null });
  await drain(m);
  assert.equal(successor(m, String(first.inference_id)).claim_text, "Carriers will pass the cost through.");
});

test("flywheel:7: a cited item that was archived, left unverified, or was replaced makes the successor REFUTED, text and confidence untouched; a prior CONFIRMED is never carried as CONFIRMED", async () => {
  for (const [name, gone] of [["archived", { is_archived: true }], ["unverified", { provenance_status: "unverified" }], ["replaced", { replaced_by: "i1" }]] as const) {
    const m = inferenceWorld({ items: [ITEM("i1"), ITEM("i2", gone)] });
    await drain(m);
    const next = successor(m, "n1");
    assert.equal(next.status_token, "REFUTED", name);
    assert.equal(next.claim_text, "Carriers will pass the cost through.", name);
    assert.equal(next.confidence, 0.62, name);
  }
  const confirmed = inferenceWorld({ inference: { status_token: "CONFIRMED" } });
  await drain(confirmed);
  assert.equal(successor(confirmed, "n1").status_token, "HYPOTHESIS");
});

test("flywheel:7: an inference with no declared inputs, or no usable confidence, is refused rather than recomputed from nothing", async () => {
  const m = inferenceWorld({ inference: { confidence: null } });
  const run = await drain(m);
  assert.equal(run.data?.skippedMethodRefused, 1);
  assert.equal(successor(m, "n1"), undefined);
});

function authorWorld(factors: Row[]) {
  const m = memoryDb({ emission_factors: factors });
  installPropagationRpcs(m.mem);
  const registry = createMethodRegistry();
  registerMarketMethods(registry, { carbonIntensity: (f) => ({ ok: true, valueGPerUnit: Number(f.ttw_co2e ?? 0) * 2, unit: "g/tkm" }), computeSeriesDeltas: () => ({}) });
  return { m, registry };
}
const figure = (id: string) => ({ table: "emission_factors", id, entity: null, method: { id: "carbon_intensity_tkm", version: "1.0.0" }, inputs: [{ table: "emission_factors", pk: id }] });

test("flywheel:32: authoring is one statement: no pre-read of the edges, two interleaved authors make one value, a second author is reported as already authored", async () => {
  const { m, registry } = authorWorld([FACTOR("F1")]);
  const [a, b] = await Promise.all([authorEdges(m.db, figure("F1"), { now: () => NOW, registry }), authorEdges(m.db, figure("F1"), { now: () => NOW, registry })]);
  assert.deepEqual([a.ok && a.action, b.ok && b.action].sort(), ["authored", "skipped-already-authored"]);
  assert.equal((m.tables.derived_values as Row[]).length, 1);
  assert.equal(m.reads.filter((r) => r.table === "derivation_edges" || r.table === "derived_values").length, 0, "the check lives in the statement, not in two reads before it");
  assert.equal(m.mem.rpcCalls.filter((c) => c.name === "author_derived_value").length, 2);
});

test("flywheel:32: authorEdges has no wall-clock fallback: a caller that passes no clock is refused", async () => {
  const { m, registry } = authorWorld([FACTOR("F1")]);
  const res = await authorEdges(m.db, figure("F1"), { registry } as never);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.action, "invalid-input");
});

test("flywheel:10: the seed op authors one value per CURRENT factor through the one path; a second run creates nothing and a superseded factor creates nothing", async () => {
  const { m, registry } = authorWorld([FACTOR("F1"), FACTOR("F2"), FACTOR("F-old", { superseded_by: "F2" })]);
  void registry;
  const deps = { sb: m.db, now: () => NOW, carbonIntensity: (f: { ttw_co2e: unknown }) => ({ ok: true as const, valueGPerUnit: Number(f.ttw_co2e ?? 0) * 2, unit: "g/tkm" }) };
  const first = await seedDerivedValues(deps, { dry: false });
  assert.equal(first.counts.created, 2);
  assert.deepEqual((m.tables.derived_values as Row[]).map((v) => (v.inputs as { pk: string }[])[0]?.pk).sort(), ["F1", "F2"]);
  const second = await seedDerivedValues(deps, { dry: false });
  assert.equal(second.counts.created, 0);
  assert.equal(second.counts.already, 2);
  assert.equal((m.tables.derived_values as Row[]).length, 2);
});
