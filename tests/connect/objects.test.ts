// The obligation-object producer: a candidate is written only when its text is verbatim in its own capture; the FuelEU Article 4(2) trajectory is data
// (ruling 8) and each period is produced only when its quote is held; the four-date timeline uses DAY-precision events only; derive twice is idempotent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildObjectRow, candidatesFromClaims, candidatesFromFueleuTargets, deriveObligationObjects, FUELEU_TARGETS, planObligationObjects, timelineFromEvents, type Candidate } from "@/features/obligations";

import { connectDb } from "./world.ts";

type Row = Record<string, unknown>;
const ITEM = { id: "i1", title: "Guidance", is_archived: false, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2026/1030", canonical_instrument_key: null };
const CAPTURE = { id: "c1", intelligence_item_id: "i1", result_content: "Article 5(1) Carriers shall report the emissions of each voyage to the authority.", result_url: "https://eur-lex.europa.eu/x", result_index: 0 };
const candidate = (over: Partial<Candidate> = {}): Candidate => ({ instrument_item_id: "i1", capture_id: "c1", pinpoint_citation: "Article 5(1)", verbatim_text: "Carriers shall report the emissions of each voyage", duty_holder_class: ["carrier"], applicability_trigger: { attribute: "instrument_in_scope", value: "x" }, ...over });
const build = (c: Candidate, over: Record<string, unknown> = {}) => buildObjectRow(c, { item: ITEM, capture: CAPTURE, existingForPinpoint: null, ...over } as never);

test("buildObjectRow: every refusal is named, and a good candidate becomes a not_assessed row at version 1", () => {
  const ok = build(candidate());
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual([ok.row.version, ok.row.status, ok.row.supersedes, ok.row.binding_position], [1, "not_assessed", null, "direct_duty"]);
  const refused = (c: Partial<Candidate>, why: string, over: Record<string, unknown> = {}) => {
    const r = build(candidate(c), over);
    assert.deepEqual(r.ok ? null : r.reason, why);
  };
  refused({ verbatim_text: "Carriers shall never report anything" }, "span_not_verbatim");
  refused({}, "capture_not_of_instrument", { capture: { ...CAPTURE, intelligence_item_id: "other" } });
  refused({}, "capture_missing", { capture: null });
  refused({}, "instrument_item_missing", { item: null });
  refused({}, "instrument_item_archived", { item: { ...ITEM, is_archived: true } });
  refused({ pinpoint_citation: " " }, "pinpoint_blank");
  refused({ duty_holder_class: [] }, "duty_holder_missing");
  refused({ duty_holder_class: ["nobody"] }, "duty_holder_unknown:nobody");
  refused({ applicability_trigger: { attribute: "", value: "x" } }, "trigger_malformed");
  refused({ status: "assessed" }, "status_not_writer_owned");
  refused({ mode: ["sea"] }, "mode_alias");
  refused({ first_deadline: "1 March 2027" }, "date_malformed:first_deadline");
  refused({ effort: { cost: 5 } }, "effort_carries_money");
  refused({ frequency: "sometimes" }, "frequency_invalid");
  refused({ binding_position: "whatever" }, "binding_position_unknown:whatever");
  refused({ duty_holder_class: ["forwarder"] }, "binding_position_unresolved", { item: { ...ITEM, instrument_identifier: null, title: "A plain notice" } });
});

test("planObligationObjects: the same text again is a no-op; a changed text versions the pinpoint and supersedes the prior", () => {
  const ctx = (existing: Row[]) => ({ itemsById: new Map([["i1", ITEM]]), capturesById: new Map([["c1", CAPTURE]]), existing: existing as never });
  const first = planObligationObjects([candidate()], ctx([]));
  assert.equal(first.toInsert.length, 1);
  const row = first.toInsert[0]?.row as Row;
  const held = [{ obligation_id: row.obligation_id, instrument_item_id: "i1", pinpoint_citation: "Article 5(1)", verbatim_text: row.verbatim_text, version: 1, supersedes: null }];
  const again = planObligationObjects([candidate()], ctx(held));
  assert.deepEqual([again.toInsert.length, again.alreadyRegistered], [0, 1]);
  const changed = planObligationObjects([candidate({ verbatim_text: "Carriers shall report the emissions" })], ctx(held));
  assert.deepEqual([changed.toInsert[0]?.row.version, changed.toInsert[0]?.row.supersedes], [2, row.obligation_id]);
  assert.equal(planObligationObjects([candidate(), candidate()], ctx([])).refused[0]?.reason, "duplicate_in_batch");
});

test("timeline: only DAY-precision events fill the four dates; a month or year is never turned into a day", () => {
  const ev = (event_date: string, event_kind: string, obligation_text: string, date_precision = "day") => ({ event_date, date_precision, event_kind, obligation_text });
  const t = timelineFromEvents([ev("2026-03-01", "entry_into_force", "enters into force"), ev("2027-01-01", "phase_step", "shall apply from"), ev("2027-06-30", "compliance_deadline", "report by"), ev("2028-01-01", "phase_step", "penalties are enforced"), ev("2026-01-15", "compliance_deadline", "earlier but only month-precise", "month")]);
  assert.deepEqual(t, { entry_into_force: "2026-03-01", date_of_application: "2027-01-01", first_deadline: "2027-06-30", enforcement_start: "2028-01-01" });
  assert.deepEqual(timelineFromEvents([ev("2026-03", "entry_into_force", "x", "month")]), { entry_into_force: null, date_of_application: null, first_deadline: null, enforcement_start: null });
});

test("candidatesFromClaims: a FACT with an Article pinpoint, a duty holder and a deontic verb, in its own capture; nothing else", () => {
  const claim = (over: Row = {}) => ({ id: "k1", claim_kind: "FACT", source_span: "Article 5(1) Carriers shall report the emissions", search_result_id: "c1", source_id: "s1", claim_text: "x", intelligence_item_id: "i1", ...over });
  const got = candidatesFromClaims(ITEM, [claim(), claim({ id: "k2", source_span: "Carriers may report" }), claim({ id: "k3", claim_kind: "OPINION" }), claim({ id: "k4", source_span: "Article 5(1) it shall be done" }), claim({ id: "k5", search_result_id: null })] as never, []);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0]?.pinpoint_citation, got[0]?.duty_holder_class], ["Article 5(1)", ["carrier"]]);
});

const FUELEU = { id: "f1", title: "FuelEU Maritime", is_archived: false, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2023/1805", canonical_instrument_key: "32023R1805" };
const heldPeriods = (n: number) => `Article 4(2) ${FUELEU_TARGETS.periods.slice(0, n).map((p) => p.quote).join(" ")}`;

test("FuelEU 2030-2050 targets are data: six periods, each produced only when its quote is verbatim in a held capture", () => {
  assert.equal(FUELEU_TARGETS.periods.length, 6);
  assert.deepEqual(FUELEU_TARGETS.periods.map((p) => p.from_date.slice(0, 4)), ["2025", "2030", "2035", "2040", "2045", "2050"]);
  for (const p of FUELEU_TARGETS.periods) assert.equal(Math.round(FUELEU_TARGETS.referenceValue.value * (1 - p.reduction_percent / 100) * 10000) / 10000, p.target_gco2e_per_mj, `${p.from_date} value follows from the reduction`);
  const all = candidatesFromFueleuTargets(FUELEU as never, [{ id: "c", intelligence_item_id: "f1", result_content: heldPeriods(6) }], []);
  assert.equal(all.length, 6);
  assert.equal(all[1]?.pinpoint_citation, "Article 4(2), from 2030-01-01");
  assert.equal(all[5]?.date_of_application, "2050-01-01");
  assert.equal(candidatesFromFueleuTargets(FUELEU as never, [{ id: "c", intelligence_item_id: "f1", result_content: heldPeriods(2) }], []).length, 2, "periods whose quote is not held are not produced");
  assert.equal(candidatesFromFueleuTargets(ITEM as never, [{ id: "c", intelligence_item_id: "i1", result_content: heldPeriods(6) }], []).length, 0, "another instrument gets none");
});

const world = () =>
  connectDb({
    intelligence_items: [FUELEU, ITEM],
    section_claim_provenance: [],
    item_forward_events: [{ intelligence_item_id: "f1", event_date: "2025-01-01", date_precision: "day", event_kind: "phase_step", obligation_text: "shall apply from 1 January 2025", confidence: "high" }],
    agent_run_searches: [{ id: "fc", intelligence_item_id: "f1", result_url: "https://eur-lex.europa.eu/x", result_content: heldPeriods(6), result_index: 0 }],
    obligation_objects: [],
  });

test("deriveObligationObjects: dry plans and writes nothing; apply writes the six periods; twice is idempotent", async () => {
  const m = world();
  const dry = await deriveObligationObjects(m.db, { dry: true, itemIds: ["f1", "i1"] });
  assert.equal(dry.counts.to_insert, 6);
  assert.equal(m.wrote("obligation_objects", "insert").length, 0);
  const first = await deriveObligationObjects(m.db, { dry: false, itemIds: ["f1", "i1"] });
  assert.equal(first.outcome, "ok", first.notes.join("; "));
  assert.equal(first.counts.inserted, 6);
  const rows = m.tables.obligation_objects as Row[];
  assert.ok(rows.every((r) => r.status === "not_assessed" && r.version === 1 && r.instrument_item_id === "f1"));
  assert.ok(rows.every((r) => r.date_of_application !== null), "the application date is the period start");
  const second = await deriveObligationObjects(m.db, { dry: false, itemIds: ["f1", "i1"] });
  assert.deepEqual([second.counts.to_insert, second.counts.already_registered], [0, 6]);
  assert.equal((m.tables.obligation_objects as Row[]).length, 6);
});

test("deriveObligationObjects: a failed read throws; it does not plan over a half-read corpus", async () => {
  const m = connectDb({ intelligence_items: [FUELEU] }, { failures: [{ table: "obligation_objects", op: "select", message: "down" }] });
  await assert.rejects(() => deriveObligationObjects(m.db, { dry: false, itemIds: ["f1"] }), /obligation_objects read failed/);
});
