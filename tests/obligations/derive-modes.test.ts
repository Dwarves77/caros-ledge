// DERIVE-2: obligation objects carry mode and statutory maximum from their own verbatim spans. INV-DRV-1 no mode without a matching rule (a title-only match is counted apart), INV-DRV-2 no maximum or formula whose figure
// is not in its span, INV-DRV-4 a second run changes nothing, INV-DRV-5 every leg mode, every rule and every unit has planted spans. (INV-DRV-3, no authored sentence, is in tests/contracts/no-authored-prose.test.ts.)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FamilyCall } from "@/core/harness";
import { LEG_MODE_CODES } from "@/core/contracts/vocabularies";
import unitFile from "@/core/parse/data/statutory-units.json" with { type: "json" };
import { statutoryUnit } from "@/core/parse/unit";
import { deriveObligationObjects, deriveObligationsJob, type Candidate } from "@/features/obligations";
import { OBJECT_DERIVATION_VERSION } from "@/features/obligations/derive/derive-objects";
import rules from "@/features/obligations/derive/data/object-rules.json" with { type: "json" };
import { cursorAfter, fillObjectFields } from "@/features/obligations/derive/fill-fields";
import { extractStatutory, groundingRefusal } from "@/features/obligations/derive/maximum";
import { classifyMode } from "@/features/obligations/derive/mode";
import { runPropagate } from "@/core/turn";

import { fixture } from "../integration/world.ts";
import { connectDb } from "../connect/world.ts";

type Row = Record<string, unknown>;
const MODE_CLASSIFIERS = rules.modeClassifiers as Array<{ id: string; on: "span" | "instrument"; modes: string[]; consignment_wide?: boolean }>;
const MAXIMUM_RULES = rules.statutoryMaximum.map((r) => ({ ...r, re: new RegExp(r.pattern, "i") }));
const STATUTORY_UNIT_TOKENS = [...new Set(unitFile.forms.map((f) => f.unit))];
const NONE = { title: "A plain notice", identifier: null };

/** Per mode rule: a span (or, for an instrument rule, a title) it reads, and one it must not. */
const MODE_CASES: Record<string, [string, string]> = {
  "air-span": ["Article 3 Aircraft operators shall monitor emissions.", "Article 3 Shipping companies shall monitor emissions."],
  "ocean-span": ["Article 4 Shipping companies shall report each voyage.", "Article 4 Aircraft operators shall report each flight."],
  "road-span": ["Article 5 Manufacturers of heavy-duty vehicles shall report.", "Article 5 Railway undertakings shall report."],
  "rail-span": ["Article 6 Railway undertakings shall publish the timetable.", "Article 6 Lorry operators shall publish the timetable."],
  "inland-waterway-span": ["Article 7 Operators of inland waterway barges shall report.", "Article 7 Operators of road haulage shall report."],
  "consignment-span": ["Article 8 Producers shall ensure packaging is recyclable.", "Article 8 Aircraft operators shall ensure compliance."],
  "air-instrument": ["ReFuelEU Aviation sustainable fuels", "Regulation on road transport"],
  "ocean-instrument": ["FuelEU Maritime initiative", "Regulation on railways"],
  "road-instrument": ["Regulation on heavy-duty vehicles CO2 standards", "FuelEU Maritime initiative"],
  "rail-instrument": ["Directive on rail transport safety", "Regulation on road transport"],
  "inland-waterway-instrument": ["NAIADES inland navigation action programme", "Regulation on rail transport"],
  "consignment-instrument": ["Packaging and Packaging Waste Regulation", "Regulation on rail transport"],
};
const SPAN_SPAN = "Article 9 Operators shall keep records of every transaction."; // no rule reads this

test("INV-DRV-5: every leg mode has a rule and two planted spans that classify to it; every rule has a positive and a negative span; a consignment-wide rule yields all five", () => {
  assert.deepEqual(Object.keys(MODE_CASES).sort(), MODE_CLASSIFIERS.map((c) => c.id).sort(), "every rule is planted, no planted case is for a rule that is gone");
  for (const c of MODE_CLASSIFIERS) {
    const [yes, no] = MODE_CASES[c.id] as [string, string];
    const read = (text: string) => (c.on === "span" ? classifyMode(text, NONE) : classifyMode(SPAN_SPAN, { title: text }));
    assert.ok(read(yes).ruleIds.includes(c.id), `${c.id} reads its positive`);
    assert.ok(!read(no).ruleIds.includes(c.id), `${c.id} does not read its negative`);
  }
  for (const mode of LEG_MODE_CODES) {
    const own = MODE_CLASSIFIERS.filter((c) => c.modes.includes(mode) && !c.consignment_wide);
    assert.ok(own.some((c) => c.on === "span"), `${mode} has a span rule`);
    const planted = own.filter((c) => { const yes = (MODE_CASES[c.id] as [string, string])[0]; return (c.on === "span" ? classifyMode(yes, NONE) : classifyMode(SPAN_SPAN, { title: yes })).modes.includes(mode); });
    assert.ok(planted.length >= 2, `${mode} has two planted spans that classify to it`);
  }
  const wide = classifyMode((MODE_CASES["consignment-span"] as [string, string])[0], NONE);
  assert.deepEqual([wide.modes, wide.consignmentWide], [LEG_MODE_CODES, true]);
  assert.deepEqual(classifyMode("Article 1 Aircraft operators and shipping companies shall report.", NONE).modes, ["ocean", "air"], "a span naming two modes is their union in vocabulary order");
});

test("INV-DRV-1: no match is no mode (never a default); the span wins over the instrument; a title-only match is counted as from the instrument", async () => {
  assert.deepEqual(classifyMode(SPAN_SPAN, NONE), { modes: [], ruleIds: [], from: null, matched: [], consignmentWide: false });
  const titled = classifyMode(SPAN_SPAN, { title: "FuelEU Maritime initiative" });
  assert.deepEqual([titled.modes, titled.from], [["ocean"], "instrument"]);
  const both = classifyMode("Article 3 Aircraft operators shall monitor emissions.", { title: "FuelEU Maritime initiative" });
  assert.deepEqual([both.modes, both.from], [["air"], "span"]);
  const plan = async (row: Row, title: string) => ((await fillObjectFields(connectDb({ intelligence_items: [{ ...ITEM, title }], obligation_objects: [row], agent_run_searches: [CAPTURE] }).db, { dry: true, after: null })).data as { plan: Array<{ patch: Row; modeAbsence: string | null }> }).plan[0] as { patch: Row; modeAbsence: string | null };
  const none = await plan(OBJ(1), "A plain notice");
  assert.deepEqual([none.patch, none.modeAbsence], [{}, "M"], "the absence token is on the plan row; the table gets nothing");
  assert.deepEqual((await plan(OBJ(1, { mode: ["ocean"] }), "Directive on rail transport safety")).patch, {}, "a mode already there is kept");
});

/** Per maximum or formula rule: a span it reads and one it must not. */
const MAX_CASES: Record<string, [string, string]> = {
  "fine-up-to": ["Member States shall provide for fines of up to EUR 2 000 per tonne.", "Member States shall provide for fines of up to the national limit."],
  "penalty-of-amount": ["The operator shall pay a penalty of EUR 40 for each tonne of carbon dioxide equivalent.", "The penalty of the operator is a matter of national law."],
  "excess-emissions-penalty": ["The excess emissions penalty shall be EUR 100 for each tonne of carbon dioxide equivalent emitted.", "Excess emissions are reported each year, EUR 100 is the fee."],
  "turnover-share": ["Fines shall be set at 5 % of the annual worldwide turnover of the company.", "Companies with a turnover of more than 450 million are in scope."],
  "shall-not-exceed": ["A fine imposed under this Article shall not exceed 5 %.", "The pollutant concentration shall not exceed 40 ug/m3."],
  "maximum-cap": ["The maximum penalty of EUR 15 000 applies.", "The maximum laden mass is 4,25 tonnes."],
  "penalty-formula": ["The penalty shall be calculated as the quantity of the shortfall multiplied by the price.", "The specific emissions target shall be calculated as follows."],
};
test("INV-DRV-5: every maximum and formula rule has a positive and a negative planted span; the written value is the fragment exactly as the span writes it", () => {
  assert.deepEqual(Object.keys(MAX_CASES).sort(), MAXIMUM_RULES.map((r) => r.id).sort());
  for (const r of MAXIMUM_RULES) {
    const [yes, no] = MAX_CASES[r.id] as [string, string];
    assert.ok(r.re.test(yes), `${r.id} reads its positive`);
    assert.ok(!r.re.test(no), `${r.id} does not read its negative`);
  }
  const found = extractStatutory("Member States shall provide for fines of up to EUR 2 000 per tonne of carbon dioxide, which they notify.");
  assert.deepEqual([found.maximum?.fragment, found.maximum?.unit, found.formula, found.refused], ["fines of up to EUR 2 000 per tonne of carbon dioxide", "EUR/tCO2e", null, []]);
  assert.equal(extractStatutory(MAX_CASES["penalty-formula"]?.[0] as string).formula?.fragment, "penalty shall be calculated as the quantity of the shortfall multiplied by the price");
});

test("statutoryUnit maps every token its data map can produce, and a fragment it does not know is null", () => {
  const cases: Record<string, string> = {
    EUR: "EUR 500", "EUR/tCO2e": "EUR 100 for each tonne of carbon dioxide", "EUR/t": "EUR 40 per tonne", "EUR/FEU": "EUR 40 per FEU", "EUR/TEU": "EUR 40 per TEU", "EUR/GJ": "EUR 2 per GJ",
    USD: "US$ 500", "USD/tCO2e": "USD 100 per tCO2", "USD/t": "USD 40 per ton", "USD/FEU": "USD 40 for each FEU", "USD/TEU": "USD 40 per TEU", "USD/GJ": "USD 2 per gigajoule",
    GBP: "£500", "GBP/tCO2e": "GBP 100 for every tonne of CO2", "GBP/t": "GBP 40 per metric tonne", "GBP/FEU": "GBP 40 per FEU", "GBP/TEU": "GBP 40 per TEU", "GBP/GJ": "GBP 2 per GJ",
    pct_turnover: "up to 5 % of the annual worldwide turnover", "gCO2e/MJ": "89.3 gCO2e/MJ", pct: "at least 2 %", t: "1 000 tonnes", MW: "40 MW", kW: "kW", months: "12 months",
    "EUR/t VLSFO-eq": "EUR per equivalent metric ton of VLSFO", "MJ/t VLSFO": "MJ per metric ton of VLSFO", year: "calendar year", "Wh/kg": "Wh/kg", kWh: "kWh", "1/h": "1/h", km: "km", ratio: "ratio", "gCO2e/tkm": "gCO2e/tonne-km", tkm: "tonne_km", "gCO2/kWh": "gCO2/kWh",
  };
  assert.deepEqual(Object.keys(cases).sort(), [...STATUTORY_UNIT_TOKENS].sort(), "every token has a planted fragment");
  for (const [token, fragment] of Object.entries(cases)) assert.equal(statutoryUnit(fragment), token, fragment);
  assert.equal(statutoryUnit("a fine of two thousand"), null);
  for (const [raw, unit] of [["EUR/t", "EUR/t"], ["gCO2e/MJ", "gCO2e/MJ"], ["pct", "pct"], ["EUR per equivalent metric ton of VLSFO", "EUR/t VLSFO-eq"], ["grams of CO2 equivalent per MJ", "gCO2e/MJ"], ["% minimum share of SAF", "pct"], ["% reduction of the reference value", "pct"], ["t", "t"]] as const) assert.equal(statutoryUnit(raw), unit, raw);
  assert.equal(statutoryUnit("a t of something"), null, "an exact form matches the whole text only");
  assert.equal(statutoryUnit("5 widgets", [{ form: "widgets", unit: "widget" }]), "widget", "forms can be handed in");
});

const ITEM = { id: "i1", title: "Guidance", provenance_status: "verified", replaced_by: null, is_archived: false, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2026/1030", canonical_instrument_key: null };
const SPAN = "Member States shall provide for fines of up to EUR 2 000 per tonne.";
const CAPTURE = { id: "c1", intelligence_item_id: "i1", result_content: `Article 5(1) Carriers shall report the emissions. ${SPAN}`, result_url: "https://eur-lex.europa.eu/x", result_index: 0 };
const candidate = (over: Partial<Candidate> = {}): Candidate => ({ instrument_item_id: "i1", capture_id: "c1", pinpoint_citation: "Article 5(1)", verbatim_text: SPAN, duty_holder_class: ["member_state"], applicability_trigger: { attribute: "instrument_in_scope", value: "x" }, ...over });
const planOf = async (c: Candidate) => (await deriveObligationObjects(connectDb({ intelligence_items: [ITEM], section_claim_provenance: [], fact_suppressions: [], item_forward_events: [], agent_run_searches: [CAPTURE], obligation_objects: [] }).db, { dry: true, itemIds: [], extraCandidates: [c] })).data as { plan: { toInsert: Array<{ row: Row }>; refused: Array<{ reason: string }> } };

test("INV-DRV-2: a maximum or formula whose figure is not in its span is refused with its reason; the same figures as the span write are accepted", async () => {
  const ok = await planOf(candidate({ statutory_maximum: "fines of up to EUR 2 000 per tonne" }));
  assert.equal(ok.plan.toInsert[0]?.row.statutory_maximum, "fines of up to EUR 2 000 per tonne");
  const refused = async (c: Partial<Candidate>, why: string) => assert.equal((await planOf(candidate(c))).plan.refused[0]?.reason, why);
  await refused({ statutory_maximum: "a fine of two thousand euros" }, "statutory_maximum_figure_missing");
  await refused({ statutory_maximum: "a fine of up to EUR 2000 per tonne" }, "statutory_maximum_figure_not_in_span:2000");
  await refused({ statutory_maximum: "fines of up to EUR 2 000 per head" }, "statutory_maximum_not_in_span");
  await refused({ cost_formula: "penalty multiplied by 3" }, "cost_formula_figure_not_in_span:3");
  await refused({ cost_formula: "calculated as the price times the volume" }, "cost_formula_not_in_span");
  assert.equal(groundingRefusal("cost_formula", "the price", "Calculated as THE   price times it"), null, "case and spacing are not a difference");
  // A candidate the producer builds from a span is born filled.
  const world = connectDb({ intelligence_items: [{ ...ITEM, title: "FuelEU Maritime initiative" }], section_claim_provenance: [], fact_suppressions: [], item_forward_events: [], agent_run_searches: [{ ...CAPTURE, result_content: `Article 5(1) Shipping companies shall report. ${SPAN}` }], obligation_objects: [] });
  const born = await deriveObligationObjects(world.db, { dry: true, itemIds: ["i1"] });
  const rows = (born.data as { plan: { toInsert: Array<{ row: Row }> } }).plan.toInsert.map((x) => x.row);
  assert.ok(rows.length > 0);
  assert.deepEqual(rows.map((r) => r.mode), rows.map(() => ["ocean"]));
});

const OBJ = (n: number, over: Row = {}): Row => ({ obligation_id: `cl:obligation:${String(n).padStart(16, "0")}`, instrument_item_id: "i1", instrument_entity_id: null, version: 1, supersedes: null, pinpoint_citation: `Article ${n}`, verbatim_text: SPAN_SPAN, plain_language: null, binding_position: "direct_duty", duty_holder_class: ["carrier"], applicability_trigger: { attribute: "a", value: "b" }, mode: null, statutory_maximum: null, cost_formula: null, status: "not_assessed", capture_id: "c1", updated_at: "2026-10-01T00:00:00Z", ...over });
const objects = (): Row[] => [
  OBJ(1, { verbatim_text: "Article 1 Aircraft operators shall report." }),
  OBJ(2, { verbatim_text: "Article 2 Shipping companies shall report; fines of up to EUR 2 000 per tonne." }),
  OBJ(3),
  OBJ(4, { mode: ["ocean"], verbatim_text: "Article 4 Aircraft operators shall report." }),
  OBJ(5, { verbatim_text: "Article 5 Producers shall ensure packaging is recyclable." }),
];

test("the backfill writes only the null columns of grounded objects, counts by token, and a second run changes zero rows (INV-DRV-4)", async () => {
  const world = connectDb({ intelligence_items: [ITEM], obligation_objects: objects(), agent_run_searches: [CAPTURE] });
  const first = await fillObjectFields(world.db, { dry: false, after: null });
  assert.deepEqual([first.outcome, first.counts.scanned, first.counts.updated, first.counts.mode_set, first.counts.mode_set_air, first.counts.mode_set_ocean, first.counts.mode_consignment_wide, first.counts.mode_unmatched, first.counts.maximum_set, first.counts.formula_set], ["ok", 5, 3, 3, 2, 2, 1, 1, 1, 0]);
  const byId = (id: string) => (world.tables.obligation_objects as Row[]).find((r) => r.obligation_id === id) as Row;
  assert.deepEqual(byId("cl:obligation:0000000000000001").mode, ["air"]);
  assert.deepEqual(byId("cl:obligation:0000000000000002").statutory_maximum, "fines of up to EUR 2 000 per tonne");
  assert.deepEqual(byId("cl:obligation:0000000000000003").mode, null, "no rule, no mode");
  assert.deepEqual(byId("cl:obligation:0000000000000004").mode, ["ocean"], "a non-null mode is never overwritten");
  assert.deepEqual(byId("cl:obligation:0000000000000005").mode, LEG_MODE_CODES);
  const stamp = (world.tables.obligation_objects as Row[]).map((r) => JSON.stringify(r));
  const writes = world.wrote("obligation_objects", "update").length;
  const again = await fillObjectFields(world.db, { dry: false, after: null });
  assert.equal(again.counts.updated, 0);
  assert.equal(world.wrote("obligation_objects", "update").length, writes, "no update statement for a row with nothing to write");
  assert.deepEqual((world.tables.obligation_objects as Row[]).map((r) => JSON.stringify(r)), stamp, "no row changed, updated_at included");
  const dry = connectDb({ intelligence_items: [ITEM], obligation_objects: objects(), agent_run_searches: [CAPTURE] });
  assert.equal((await fillObjectFields(dry.db, { dry: true, after: null })).counts.mode_set, 3);
  assert.equal(dry.wrote("obligation_objects", "update").length, 0, "a dry run writes nothing");
});

test("a title-only match is counted apart, and a guard that refuses one object refuses that object alone", async () => {
  const world = connectDb({ intelligence_items: [{ ...ITEM, title: "FuelEU Maritime initiative" }], obligation_objects: objects().slice(2, 3).concat(OBJ(6)), agent_run_searches: [CAPTURE] }, { failures: [{ table: "obligation_objects", op: "update", message: "obligation_object_span_not_verbatim", when: (c) => c.filters.some(([k, v]) => k === "in:obligation_id" && (v as string[]).length > 1) }] });
  const r = await fillObjectFields(world.db, { dry: false, after: null });
  assert.deepEqual([r.counts.mode_from_title, r.counts.updated, r.outcome], [2, 2, "ok"], "the group failed, each row was retried alone");
  const refusing = connectDb({ intelligence_items: [{ ...ITEM, title: "FuelEU Maritime initiative" }], obligation_objects: [OBJ(3)], agent_run_searches: [CAPTURE] }, { failures: [{ table: "obligation_objects", op: "update", message: "obligation_object_span_not_verbatim" }] });
  const bad = await fillObjectFields(refusing.db, { dry: false, after: null });
  assert.deepEqual([bad.outcome, bad.counts.updated, bad.counts.refused], ["partial", 0, 1]);
  assert.match(bad.notes[0] as string, /obligation_object_span_not_verbatim/);
});

test("a batch is bounded and carries a cursor by obligation_id; a short batch or a new derivation version wraps to the start", async () => {
  const world = connectDb({ intelligence_items: [ITEM], obligation_objects: objects(), agent_run_searches: [CAPTURE] });
  const one = await fillObjectFields(world.db, { dry: true, batch: 2, after: null });
  assert.deepEqual([one.counts.scanned, one.data?.ids.derive_cursor[0]], [2, "cl:obligation:0000000000000002"]);
  const two = await fillObjectFields(world.db, { dry: true, batch: 2, after: cursorAfter(one.data?.ids.derive_cursor) });
  assert.deepEqual([two.counts.scanned, two.data?.plan[0]?.obligation_id], [2, "cl:obligation:0000000000000003"]);
  const last = await fillObjectFields(world.db, { dry: true, batch: 2, after: cursorAfter(two.data?.ids.derive_cursor) });
  assert.deepEqual([last.counts.scanned, last.data?.ids.derive_cursor], [1, []]);
  assert.equal(cursorAfter([]), null);
  assert.equal(cursorAfter(["cl:obligation:0000000000000002", "an-older-version"]), null);
});

test("the propagate stage fills a bounded batch after the cursor the last apply turn left, advances it in its ids, and does nothing unless asked", async () => {
  const f = fixture();
  f.db.seed("obligation_objects", objects());
  f.db.seed("intelligence_items", [ITEM]);
  const call = (input: Record<string, unknown>, dry = false): FamilyCall => ({ mode: dry ? "dry" : "apply", dry, input, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", upstream: null }) as FamilyCall;
  const idle = await runPropagate(call({}), f.d);
  assert.equal(idle.counts.derive_scanned, undefined, "no derive key, no derivation");
  const dry = await runPropagate(call({ derive: { only: "modes-and-maximum", batch: 2 } }, true), f.d);
  assert.deepEqual([dry.counts.derive_scanned, dry.counts.derive_mode_set, (dry.data as { ids: { derive_cursor: string[] } }).ids.derive_cursor], [2, 2, ["cl:obligation:0000000000000002", OBJECT_DERIVATION_VERSION]]);
  assert.equal(f.db.rows("obligation_objects").filter((r) => r.mode !== null).length, 1, "a dry run writes nothing");
  f.db.seed("harness_runs", [{ id: "h1", family: "propagation", root_run_id: "h1", trigger: "dispatch", mode: "apply", outcome: "success", inputs: {}, outputs: { counts: {}, ids: { derive_cursor: ["cl:obligation:0000000000000001", OBJECT_DERIVATION_VERSION] } }, started_at: "2026-10-25T00:00:00Z", finished_at: "2026-10-25T00:00:01Z", forced_dry: false }]);
  const next = await runPropagate(call({ derive: { batch: 2 } }), f.d);
  assert.deepEqual([next.counts.derive_scanned, next.counts.derive_updated, (next.data as { ids: { derive_cursor: string[] } }).ids.derive_cursor], [2, 1, ["cl:obligation:0000000000000003", OBJECT_DERIVATION_VERSION]], next.notes.join("|"));
  assert.deepEqual(f.db.rows("obligation_objects").find((r) => r.obligation_id === "cl:obligation:0000000000000001")?.mode, null, "objects before the cursor are not read");
  const refused = await runPropagate(call({ derive: { only: "everything" } }), f.d);
  assert.equal(refused.outcome, "failed");
});

test("a word that merely contains a mode word is not that mode: shipments and relationship are not ships", () => {
  for (const span of ["Article 9 Shipments of waste shall be accompanied by the form.", "Article 9 The relationship between the operator and the authority shall be recorded."]) assert.deepEqual(classifyMode(span, NONE).modes, [], span);
  assert.deepEqual(classifyMode("Article 9 Operators shall keep records.", { title: "Regulation on shipments and the relationship of parties" }).modes, [], "nor in an instrument title");
});

test("the server answers at most 1,000 rows a response: 1,200 objects are all filled, across pages of one call or across turns, and then nothing changes", async () => {
  const many = (): Row[] => Array.from({ length: 1200 }, (_, i) => OBJ(i + 1, { verbatim_text: `Article ${i + 1} Aircraft operators shall report.` }));
  const one = connectDb({ intelligence_items: [ITEM], obligation_objects: many(), agent_run_searches: [CAPTURE] });
  const all = await fillObjectFields(one.db, { dry: false, batch: 2000, after: null });
  assert.deepEqual([all.counts.scanned, all.counts.updated, all.data?.ids.derive_cursor], [1200, 1200, []]);
  assert.equal((one.tables.obligation_objects as Row[]).filter((r) => r.mode === null).length, 0);
  const turns = connectDb({ intelligence_items: [ITEM], obligation_objects: many(), agent_run_searches: [CAPTURE] });
  let after: string | null = null;
  const updated: number[] = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const r = await fillObjectFields(turns.db, { dry: false, batch: 1000, after });
    updated.push(r.counts.updated as number);
    after = cursorAfter(r.data?.ids.derive_cursor);
  }
  assert.deepEqual(updated, [1000, 200, 0], "a turn's batch is a cap, the end is an empty page, and the third turn changes nothing");
  assert.equal((turns.tables.obligation_objects as Row[]).filter((r) => r.mode === null).length, 0);
  const job = connectDb({ intelligence_items: [ITEM], obligation_objects: many(), agent_run_searches: [CAPTURE], section_claim_provenance: [], fact_suppressions: [], item_forward_events: [] });
  const replay = await deriveObligationsJob({ sb: job.db }, { dry: false });
  assert.equal(replay.counts.fill_updated, 1200, replay.notes.join("|"));
});
