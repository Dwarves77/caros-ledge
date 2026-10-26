// The obligation-object producer: a candidate is written only when its text is verbatim in its own capture; the FuelEU Article 4(2) trajectory is data
// (ruling 8) and each period is produced only when its quote is held; the four-date timeline uses DAY-precision events only; derive twice is idempotent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isVerbatim } from "@/core/contracts";
import { deriveObligationObjects, type Candidate } from "@/features/obligations";
import fueleuTargets from "@/features/obligations/derive/data/fueleu-targets.json" with { type: "json" };

const FUELEU_TARGETS = fueleuTargets as { referenceValue: { value: number }; periods: Array<{ from_date: string; quote: string; reduction_percent: number; target_gco2e_per_mj: number }> };

import { connectDb } from "./world.ts";

type Row = Record<string, unknown>;
const ITEM = { id: "i1", title: "Guidance", provenance_status: "verified", replaced_by: null, is_archived: false, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2026/1030", canonical_instrument_key: null };
const CAPTURE = { id: "c1", intelligence_item_id: "i1", result_content: "Article 5(1) Carriers shall report the emissions of each voyage to the authority.", result_url: "https://eur-lex.europa.eu/x", result_index: 0 };
const candidate = (over: Partial<Candidate> = {}): Candidate => ({ instrument_item_id: "i1", capture_id: "c1", pinpoint_citation: "Article 5(1)", verbatim_text: "Carriers shall report the emissions of each voyage", duty_holder_class: ["carrier"], applicability_trigger: { attribute: "instrument_in_scope", value: "x" }, ...over });
type Plan = { toInsert: Array<{ row: Row }>; refused: Array<{ reason: string }>; alreadyRegistered: number };
const planOf = (r: { data?: unknown }): Plan => (r.data as { plan: Plan }).plan;
/** The tables a derive reads, with the instrument, its capture and nothing registered; `over` replaces any of them. */
const worldOf = (over: Record<string, Row[]> = {}) => connectDb({ intelligence_items: [ITEM], section_claim_provenance: [], fact_suppressions: [], item_forward_events: [], agent_run_searches: [CAPTURE], obligation_objects: [], ...over });
/** A dry derive of one handed-in candidate: the plan the registry would make. */
const planFor = async (c: Candidate, over: Record<string, Row[]> = {}) => planOf(await deriveObligationObjects(worldOf(over).db, { dry: true, itemIds: [], extraCandidates: [c] }));

test("a candidate: every refusal is named, and a good candidate becomes a not_assessed row at version 1", async () => {
  const ok = await planFor(candidate());
  assert.deepEqual([ok.toInsert[0]?.row.version, ok.toInsert[0]?.row.status, ok.toInsert[0]?.row.supersedes, ok.toInsert[0]?.row.binding_position], [1, "not_assessed", null, "direct_duty"]);
  const refused = async (c: Partial<Candidate>, why: string, over: Record<string, Row[]> = {}) => assert.deepEqual((await planFor(candidate(c), over)).refused[0]?.reason, why);
  await refused({ verbatim_text: "Carriers shall never report anything" }, "span_not_verbatim");
  await refused({}, "capture_not_of_instrument", { agent_run_searches: [{ ...CAPTURE, intelligence_item_id: "other" }] });
  await refused({}, "capture_missing", { agent_run_searches: [] });
  await refused({}, "instrument_item_missing", { intelligence_items: [] });
  await refused({ pinpoint_citation: " " }, "pinpoint_blank");
  await refused({ duty_holder_class: [] }, "duty_holder_missing");
  await refused({ duty_holder_class: ["nobody"] }, "duty_holder_unknown:nobody");
  await refused({ applicability_trigger: { attribute: "", value: "x" } }, "trigger_malformed");
  await refused({ status: "assessed" }, "status_not_writer_owned");
  await refused({ mode: ["sea"] }, "mode_alias");
  await refused({ first_deadline: "1 March 2027" }, "date_malformed:first_deadline");
  await refused({ effort: { cost: 5 } }, "effort_carries_money");
  await refused({ frequency: "sometimes" }, "frequency_invalid");
  await refused({ binding_position: "whatever" }, "binding_position_unknown:whatever");
  await refused({ duty_holder_class: ["forwarder"] }, "binding_position_unresolved", { intelligence_items: [{ ...ITEM, instrument_identifier: null, title: "A plain notice" }] });
});

test("registering: the same text again is a no-op; a changed text versions the pinpoint and supersedes the prior; a repeat in one batch is refused", async () => {
  const m = worldOf();
  const first = await deriveObligationObjects(m.db, { dry: false, itemIds: [], extraCandidates: [candidate()] });
  assert.equal(first.counts.inserted, 1);
  const held = (m.tables.obligation_objects as Row[])[0] as Row;
  const again = await deriveObligationObjects(m.db, { dry: true, itemIds: [], extraCandidates: [candidate()] });
  assert.deepEqual([planOf(again).toInsert.length, planOf(again).alreadyRegistered], [0, 1]);
  const changed = planOf(await deriveObligationObjects(m.db, { dry: true, itemIds: [], extraCandidates: [candidate({ verbatim_text: "Carriers shall report the emissions" })] }));
  assert.deepEqual([changed.toInsert[0]?.row.version, changed.toInsert[0]?.row.supersedes], [2, held.obligation_id]);
  const twice = planOf(await deriveObligationObjects(worldOf().db, { dry: true, itemIds: [], extraCandidates: [candidate(), candidate()] }));
  assert.equal(twice.refused[0]?.reason, "duplicate_in_batch");
});

test("claims and the timeline: a FACT with an Article pinpoint, a duty holder and a deontic verb, in its own capture, becomes one candidate; only DAY-precision events fill the four dates, a month or year is never turned into a day", async () => {
  const claim = (over: Row = {}) => ({ id: "k1", claim_kind: "FACT", source_span: "Article 5(1) Carriers shall report the emissions", search_result_id: "c1", source_id: "s1", claim_text: "x", intelligence_item_id: "i1", ...over });
  const ev = (event_date: string, event_kind: string, obligation_text: string, date_precision = "day"): Row => ({ intelligence_item_id: "i1", event_date, date_precision, event_kind, obligation_text, confidence: "high" });
  const derive = async (events: Row[]) => planOf(await deriveObligationObjects(worldOf({ section_claim_provenance: [claim(), claim({ id: "k2", source_span: "Carriers may report" }), claim({ id: "k3", claim_kind: "OPINION" }), claim({ id: "k4", source_span: "Article 5(1) it shall be done" }), claim({ id: "k5", search_result_id: null })], item_forward_events: events }).db, { dry: true, itemIds: ["i1"] }));
  const plan = await derive([ev("2026-03-01", "entry_into_force", "enters into force"), ev("2027-01-01", "phase_step", "shall apply from"), ev("2027-06-30", "compliance_deadline", "report by"), ev("2028-01-01", "phase_step", "penalties are enforced"), ev("2026-01-15", "compliance_deadline", "an earlier month-level date", "month")]);
  assert.equal(plan.toInsert.length, 1, "only the first claim is a candidate");
  const row = plan.toInsert[0]?.row as Row;
  assert.deepEqual([row.pinpoint_citation, row.duty_holder_class], ["Article 5(1)", ["carrier"]]);
  assert.deepEqual([row.entry_into_force, row.date_of_application, row.first_deadline, row.enforcement_start], ["2026-03-01", "2027-01-01", "2027-06-30", "2028-01-01"]);
  const coarse = (await derive([ev("2026-03", "entry_into_force", "x", "month")])).toInsert[0]?.row as Row;
  assert.deepEqual([coarse.entry_into_force, coarse.date_of_application, coarse.first_deadline, coarse.enforcement_start], [null, null, null, null]);
});

const FUELEU = { id: "f1", title: "FuelEU Maritime", provenance_status: "verified", replaced_by: null, is_archived: false, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2023/1805", canonical_instrument_key: "32023R1805" };
const heldPeriods = (n: number) => `Article 4(2) ${FUELEU_TARGETS.periods.slice(0, n).map((p) => p.quote).join(" ")}`;

test("FuelEU 2030-2050 targets are data: six periods, each produced only when its quote is verbatim in a held capture", async () => {
  assert.equal(FUELEU_TARGETS.periods.length, 6);
  assert.deepEqual(FUELEU_TARGETS.periods.map((p) => p.from_date.slice(0, 4)), ["2025", "2030", "2035", "2040", "2045", "2050"]);
  for (const p of FUELEU_TARGETS.periods) assert.equal(Math.round(FUELEU_TARGETS.referenceValue.value * (1 - p.reduction_percent / 100) * 10000) / 10000, p.target_gco2e_per_mj, `${p.from_date} value follows from the reduction`);
  const all = (planOf(await deriveObligationObjects(world().db, { dry: true, itemIds: ["f1"] })).toInsert.map((x) => x.row)).sort((a, b) => String(a.date_of_application).localeCompare(String(b.date_of_application)));
  assert.equal(all.length, 6);
  assert.equal(all[1]?.pinpoint_citation, "Article 4(2), from 2030-01-01");
  assert.equal(all[5]?.date_of_application, "2050-01-01");
  const some = await deriveObligationObjects(world(heldPeriods(2)).db, { dry: true, itemIds: ["f1"] });
  assert.equal(planOf(some).toInsert.length, 2, "periods whose quote is not held are not produced");
  const other = await deriveObligationObjects(connectDb({ intelligence_items: [ITEM], section_claim_provenance: [], fact_suppressions: [], item_forward_events: [], agent_run_searches: [{ id: "c", intelligence_item_id: "i1", result_url: "https://eur-lex.europa.eu/x", result_content: heldPeriods(6), result_index: 0 }], obligation_objects: [] }).db, { dry: true, itemIds: ["i1"] });
  assert.equal(planOf(other).toInsert.length, 0, "another instrument gets none");
});

test("FuelEU periods are found in a structured capture (CAPTURE-STRUCT-1): the quote's words may sit on other lines, and the capture's own slice is stored", async () => {
  const structured = `Article 4(2)\n\n${FUELEU_TARGETS.periods.map((p) => p.quote.replace(/ /g, "\t")).join("\n\n")}`;
  const plan = planOf(await deriveObligationObjects(world(structured).db, { dry: true, itemIds: ["f1"] }));
  assert.equal(plan.toInsert.length, 6);
  for (const x of plan.toInsert) assert.ok(isVerbatim(structured, String(x.row.verbatim_text)), "the stored text is exactly in the capture");
});

const world = (held: string = heldPeriods(6)) =>
  connectDb({
    intelligence_items: [FUELEU, ITEM],
    section_claim_provenance: [],
    item_forward_events: [{ intelligence_item_id: "f1", event_date: "2025-01-01", date_precision: "day", event_kind: "phase_step", obligation_text: "shall apply from 1 January 2025", confidence: "high" }],
    agent_run_searches: [{ id: "fc", intelligence_item_id: "f1", result_url: "https://eur-lex.europa.eu/x", result_content: held, result_index: 0 }],
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
