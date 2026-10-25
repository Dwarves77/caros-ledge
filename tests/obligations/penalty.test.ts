// DERIVE-3: penalty provisions as derived obligation objects. INV-D3-1 every penalty field is a verbatim fragment of its object's span (or a token whose basis is), INV-D3-2 "fines" as a material noun is no penalty, INV-D3-3 the statutory
// schedule joins its object, INV-D3-4 a capture bound to no item is refused and the binder binds it, INV-D3-5 a second apply changes nothing, INV-D3-7 Article 16(3) is its own object and the object beside it is not touched.
// (INV-D3-6, no authored prose in the slot and the section, is in tests/workspace/penalty-readers.test.ts.)
import assert from "node:assert/strict";
import { test } from "node:test";

import { bindInstrumentCaptures, itemForCitedUrl } from "@/core/fetch";
import { deriveObligationObjects, type Candidate } from "@/features/obligations";
import { OBJECT_DERIVATION_VERSION } from "@/features/obligations/derive/derive-objects";
import { fillObjectFields } from "@/features/obligations/derive/fill-fields";
import { extractPenalty } from "@/features/obligations/derive/penalty";
import classes from "@/features/obligations/derive/data/sanction-classes.json" with { type: "json" };
import { runConnect } from "@/core/turn";
import { captureCited } from "@/core/turn/stages/capture";

import { connectDb } from "../connect/world.ts";
import { fixture } from "../integration/world.ts";

import * as F from "./penalty-fixture.ts";

type Row = Record<string, unknown>;
const TOKENS = new Set(classes.classes.map((c) => c.token));
const item = (id: string, over: Row = {}): Row => ({ id, title: "Instrument", provenance_status: "verified", replaced_by: null, is_archived: false, item_type: "regulation", jurisdiction_iso: ["EU"], instrument_identifier: null, canonical_instrument_key: null, instrument_entity_id: null, source_url: null, ...over });
const capture = (id: string, itemId: string | null, text: string, over: Row = {}): Row => ({ id, intelligence_item_id: itemId, result_content: text, result_url: `https://eur-lex.europa.eu/doc/${id.slice(-4)}`, result_index: 0, agent_run_id: `run-${id.slice(-4)}`, searched_at: "2026-10-25T00:00:00Z", ...over });
const FUELEU = item(F.FUELEU_ITEM, { title: "EU Regulation 2023/1805 - Official Journal", instrument_identifier: "2023/1805", canonical_instrument_key: "32023R1805", instrument_entity_id: F.FUELEU_ENTITY });
const ETS = item(F.ETS_ITEM, { title: "Directive 2003/87/EC establishing a scheme for greenhouse gas emission allowance trading", instrument_identifier: "32003L0087", canonical_instrument_key: "32003L0087" });
const MATERIAL = item(F.MATERIAL_ITEM, { title: "Commission Regulation (EU) No 147/2013", instrument_identifier: "Regulation (EU) No 147/2013" });
const FUELEU_DUTY = "Article 4 GHG intensity limits 1. Shipping companies shall ensure that the GHG intensity of the energy used on board a ship during a reporting period does not exceed the limit.";
const schedule = (id: string, scenario: string, result: number, unit: string, article: string): Row => ({ computation_id: id, entity_id: F.FUELEU_ENTITY, scenario_key: scenario, obligation_id: F.FUELEU_OBLIGATION, formula_id: "fueleu_penalty_basis", formula_version: "1.0.0", result, result_unit: unit, inputs: [{ article, table: "sources" }] });
const SCHEDULE = [schedule("sc-1", "eur_per_t_vlsfoe", 2400, "EUR per equivalent metric ton of VLSFO", "Annex IV Part B"), schedule("sc-2", "mj_per_t_vlsfo", 41000, "MJ per metric ton of VLSFO", "Annex IV Part B"), schedule("sc-3", "berth_non_compliance", 1.5, "EUR", "Article 23(5)")];
const ENTITY = { entity_id: F.FUELEU_OBLIGATION, kind: "obligation", canonical_name: "FuelEU Maritime Article 23 penalty and the Annex IV Part B formula" };
const existingObject = (id: string, pinpoint: string, itemId: string, text: string): Row => ({ obligation_id: id, instrument_item_id: itemId, version: 1, supersedes: null, pinpoint_citation: pinpoint, verbatim_text: text, plain_language: null, binding_position: "direct_duty", duty_holder_class: ["member_state"], applicability_trigger: { attribute: "instrument_in_scope", value: "32003L0087" }, mode: null, statutory_maximum: null, cost_formula: null, sanction_class: null, enforcement_start: null, capture_id: F.ETS_CAPTURE, status: "not_assessed" });
const ART16_EXISTING = existingObject("cl:obligation:8aed84709c9a1ec5", "Article 16", F.ETS_ITEM, "Article 16 Penalties 1. Member States shall lay down the rules on penalties applicable to infringements");

function world(extra: Record<string, Row[]> = {}) {
  return connectDb({
    intelligence_items: [FUELEU, ETS, MATERIAL],
    agent_run_searches: [capture(F.FUELEU_CAPTURE, F.FUELEU_ITEM, `${FUELEU_DUTY} ${F.FUELEU_TEXT}`), capture(F.ETS_CAPTURE, F.ETS_ITEM, F.ETS_TEXT), capture(F.MATERIAL_CAPTURE, F.MATERIAL_ITEM, F.MATERIAL_TEXT)],
    obligation_objects: [],
    statutory_computations: SCHEDULE,
    entities: [ENTITY],
    ...extra,
  });
}
type Plan = { toInsert: { row: Row }[]; refused: { instrument_item_id: string | null; pinpoint_citation: string | null; reason: string }[] };
const planOf = (r: { data?: unknown }): Plan => (r.data as { plan: Plan }).plan;
const rowOf = (plan: Plan, itemId: string, pinpoint: string): Row => {
  const hit = plan.toInsert.find((p) => p.row.instrument_item_id === itemId && p.row.pinpoint_citation === pinpoint)?.row;
  assert.ok(hit, `${pinpoint} on ${itemId} is planned; planned: ${plan.toInsert.map((p) => `${p.row.instrument_item_id}|${p.row.pinpoint_citation}`).join(", ")}; refused: ${JSON.stringify(plan.refused)}`);
  return hit;
};

test("D1/D2 worked examples: Article 16(3), 16(3a), 23(2), 23(5) and Annex IV Part B are objects with a class, and every fragment is the span's own text (INV-D3-1)", async () => {
  const w = world();
  const plan = planOf(await deriveObligationObjects(w.db, { dry: true, itemIds: [F.FUELEU_ITEM, F.ETS_ITEM] }));
  const want: [string, string, string][] = [[F.ETS_ITEM, "Article 16(1)", "member_state_defined"], [F.ETS_ITEM, "Article 16(3)", "monetary_per_unit"], [F.ETS_ITEM, "Article 16(3a)", "by_reference"], [F.FUELEU_ITEM, "Article 23(2)", "monetary_formula"], [F.FUELEU_ITEM, "Article 23(5)", "monetary_formula"], [F.FUELEU_ITEM, "Annex IV Part B", "monetary_per_unit"]];
  for (const [id, pin, token] of want) assert.equal(rowOf(plan, id, pin).sanction_class, token, pin);
  const art16 = rowOf(plan, F.ETS_ITEM, "Article 16(3)");
  assert.equal(art16.statutory_maximum, "excess emissions penalty shall be EUR 100 for each tonne of carbon dioxide equivalent");
  assert.equal(rowOf(plan, F.FUELEU_ITEM, "Article 23(5)").statutory_maximum, "EUR 1,5");
  assert.match(String(rowOf(plan, F.FUELEU_ITEM, "Annex IV Part B").cost_formula), /^2 400 8\. Is the amount to be paid in EUR per equivalent metric ton of VLSFO$/);
  assert.match(String(rowOf(plan, F.FUELEU_ITEM, "Article 23(2)").cost_formula), /multiplied by 1 \+ \(n -1\)\/10/);
  for (const { row } of plan.toInsert.filter((p) => p.row.sanction_class)) {
    const span = String(row.verbatim_text);
    assert.ok(TOKENS.has(String(row.sanction_class)), "a token of the data file");
    for (const col of ["statutory_maximum", "cost_formula"] as const) if (row[col] !== null) assert.ok(span.includes(String(row[col])), `${String(row.pinpoint_citation)} ${col} is a fragment of its span`);
    assert.ok(extractPenalty(span).sanction_class?.fragment && span.includes(extractPenalty(span).sanction_class?.fragment as string), "the class's basis is a fragment of the span");
    assert.ok(F.FUELEU_TEXT.includes(span) || F.ETS_TEXT.includes(span), "the span is the capture's own text");
  }
  // the paragraphs with a penalty word and no trigger are refused with the reason, never silently dropped
  assert.ok(plan.refused.some((r) => r.pinpoint_citation === "Article 16(4)" && r.reason === "penalty_word_without_trigger"));
});

test("INV-D3-1 attack: a session-authored class with no basis in the span, an unknown token and a recomposed maximum are refused with their reasons", async () => {
  const base: Candidate = { instrument_item_id: F.ETS_ITEM, capture_id: F.ETS_CAPTURE, pinpoint_citation: "Article 15(1)", verbatim_text: "Article 15 Verification 1. Member States shall ensure that reports are verified.", duty_holder_class: ["member_state"], applicability_trigger: { attribute: "instrument_in_scope", value: "32003L0087" } };
  const w = world();
  const r = await deriveObligationObjects(w.db, { dry: true, itemIds: [], extraCandidates: [{ ...base, sanction_class: "monetary_per_unit" }, { ...base, pinpoint_citation: "Article 15(2)", sanction_class: "severe" }, { ...base, pinpoint_citation: "Article 15(3)", statutory_maximum: "a fine of two thousand euros" }] });
  assert.deepEqual(planOf(r).refused.filter((x) => x.pinpoint_citation?.startsWith("Article 15(")).map((x) => x.reason.split(":")[0]), ["sanction_class_basis_not_in_span", "sanction_class_unknown", "statutory_maximum_figure_missing"]);
  assert.equal(planOf(r).toInsert.filter((p) => String(p.row.pinpoint_citation).startsWith("Article 15(")).length, 0);
});

test("INV-D3-2: 'fines' as a material noun (Regulation 147/2013) yields no class and no candidate; an adjective and a procedural penalty notice likewise; a real fine is not excluded", async () => {
  const sample = extractPenalty(`The captured source states, verbatim: «${F.MATERIAL_SENTENCE}»`);
  assert.equal(sample.sanction_class, null);
  assert.deepEqual(sample.refused, ["excluded:fines-material-noun"]);
  assert.deepEqual(extractPenalty("a very fine mesh of 0,5 mm is required").refused, ["excluded:fine-adjective"]);
  assert.deepEqual(extractPenalty("a penalty notice under Part 10 may be provided or given to that person in electronic form").refused, ["excluded:penalty-notice-procedure"]);
  assert.equal(extractPenalty("The operator shall pay fines of up to EUR 2 000 per tonne of carbon dioxide.").sanction_class?.token, "monetary_per_unit");
  const plan = planOf(await deriveObligationObjects(world().db, { dry: true, itemIds: [F.MATERIAL_ITEM] }));
  assert.equal(plan.toInsert.filter((p) => String(p.row.verbatim_text).includes("fines")).length, 0);
  assert.ok(plan.refused.some((r) => r.instrument_item_id === F.MATERIAL_ITEM && r.reason === "excluded:fines-material-noun"));
});

test("INV-D3-3: the obligation entity the statutory schedule authored is reused by the object that cites its article most, once; every schedule row then joins an object", async () => {
  const w = world();
  const r = await deriveObligationObjects(w.db, { dry: false, itemIds: [F.FUELEU_ITEM] });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  const objects = w.tables.obligation_objects as Row[];
  assert.deepEqual(objects.filter((o) => o.obligation_id === F.FUELEU_OBLIGATION).map((o) => o.pinpoint_citation), ["Annex IV Part B"], "the Annex IV Part B object (two of the three rows cite it) takes the entity, and only one object does");
  const ids = new Set(objects.map((o) => o.obligation_id));
  assert.ok((w.tables.statutory_computations as Row[]).every((s) => ids.has(s.obligation_id)), "all three fueleu_penalty_basis rows join an obligation_objects row");
  assert.notEqual(objects.find((o) => o.pinpoint_citation === "Article 23(5)")?.obligation_id, F.FUELEU_OBLIGATION);
});

test("INV-D3-3 control: an entity an object already carries is not taken again", async () => {
  const w = world({ obligation_objects: [existingObject(F.FUELEU_OBLIGATION, "Article 99", F.FUELEU_ITEM, "x")] });
  await deriveObligationObjects(w.db, { dry: false, itemIds: [F.FUELEU_ITEM] });
  assert.equal((w.tables.obligation_objects as Row[]).filter((o) => o.obligation_id === F.FUELEU_OBLIGATION).length, 1);
});

test("INV-D3-4: a candidate on a capture bound to no item is refused; the binder binds the NULL-item captures whose CELEX or ELI names exactly one live item and reports the rest with reasons", async () => {
  const loose = capture("00000000-0000-4000-8000-00000000c101", null, F.ETS_TEXT, { result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02003L0087-20240301" });
  const candidate: Candidate = { instrument_item_id: F.ETS_ITEM, capture_id: String(loose.id), pinpoint_citation: "Article 16(3)", verbatim_text: F.ART16_3, duty_holder_class: ["member_state"], applicability_trigger: { attribute: "instrument_in_scope", value: "x" } };
  const w0 = world({ agent_run_searches: [loose] });
  assert.equal(planOf(await deriveObligationObjects(w0.db, { dry: true, itemIds: [], extraCandidates: [candidate] })).refused[0]?.reason, "capture_not_of_instrument");
  const rows = [
    loose,
    capture("00000000-0000-4000-8000-00000000c102", null, "a", { result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805" }),
    capture("00000000-0000-4000-8000-00000000c103", null, "b", { result_url: "https://eur-lex.europa.eu/eli/reg/2023/1805/oj/eng" }),
    capture("00000000-0000-4000-8000-00000000c104", null, "c", { result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32099R9999" }),
    capture("00000000-0000-4000-8000-00000000c105", null, "d", { result_url: "https://example.test/page" }),
    capture("00000000-0000-4000-8000-00000000c106", null, "e", { result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R0001" }),
  ];
  const twin = (id: string): Row => item(id, { canonical_instrument_key: "32024R0001" });
  const w = world({ intelligence_items: [FUELEU, ETS, twin("00000000-0000-4000-8000-00000000f0a1"), twin("00000000-0000-4000-8000-00000000f0a2")], agent_run_searches: rows, agent_runs: rows.map((r) => ({ id: r.agent_run_id, intelligence_item_id: null })) });
  const dry = await bindInstrumentCaptures({ sb: w.db }, { dry: true });
  assert.deepEqual([dry.counts.unbound, dry.counts.to_bind, dry.counts.unbound_no_item, dry.counts.unbound_no_key, dry.counts.unbound_ambiguous], [6, 3, 1, 1, 1]);
  assert.ok((w.tables.agent_run_searches as Row[]).every((c) => c.intelligence_item_id === null), "dry wrote nothing");
  const applied = await bindInstrumentCaptures({ sb: w.db }, { dry: false });
  assert.equal(applied.counts.bound, 3);
  const bound = (id: string) => (w.tables.agent_run_searches as Row[]).find((c) => c.id === id)?.intelligence_item_id;
  assert.deepEqual(["c101", "c102", "c103"].map((s) => bound(`00000000-0000-4000-8000-00000000${s}`)), [F.ETS_ITEM, F.FUELEU_ITEM, F.FUELEU_ITEM], "a consolidated CELEX is of its base instrument; an ELI path names the same instrument as its CELEX");
  assert.equal((w.tables.agent_runs as Row[]).filter((r) => r.intelligence_item_id !== null).length, 3, "the run rows follow their captures");
  assert.equal((await bindInstrumentCaptures({ sb: w.db }, { dry: false })).counts.bound, 0, "INV-D3-5: a second apply binds nothing");
  // the guard's own rule now holds for the consolidated capture: the same candidate is no longer refused for its capture
  assert.notEqual(planOf(await deriveObligationObjects(w.db, { dry: true, itemIds: [], extraCandidates: [candidate] })).refused[0]?.reason, "capture_not_of_instrument");
  assert.equal(await itemForCitedUrl(w.db, "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805"), F.FUELEU_ITEM);
  assert.equal(await itemForCitedUrl(w.db, "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R0001"), null, "two items for one key bind to neither");
});

test("INV-D3-5: a second apply writes zero rows and changes zero rows (derive, then the backfill of the existing objects)", async () => {
  const w = world({ obligation_objects: [ART16_EXISTING] });
  const first = await deriveObligationObjects(w.db, { dry: false, itemIds: [F.FUELEU_ITEM, F.ETS_ITEM] });
  assert.ok((first.counts.inserted ?? 0) >= 6, first.notes.join("|"));
  const after = JSON.stringify(w.tables.obligation_objects);
  const second = await deriveObligationObjects(w.db, { dry: false, itemIds: [F.FUELEU_ITEM, F.ETS_ITEM] });
  assert.deepEqual([second.counts.inserted, second.counts.to_insert], [0, 0]);
  assert.equal(JSON.stringify(w.tables.obligation_objects), after);
  const fill1 = await fillObjectFields(w.db, { dry: false, after: null });
  assert.equal(fill1.counts.sanction_set, 1, "the one existing object whose span states a class is filled");
  const filled = JSON.stringify(w.tables.obligation_objects);
  const fill2 = await fillObjectFields(w.db, { dry: false, after: null });
  assert.equal(fill2.counts.updated, 0, "nothing is filled twice");
  assert.equal(JSON.stringify(w.tables.obligation_objects), filled);
  assert.ok(OBJECT_DERIVATION_VERSION.includes("2026-10-26"), "the derivation version is bumped, so the connect stage reads every item again");
});

test("INV-D3-7: Article 16(3) becomes its own object beside the existing Article 16 object, whose row is byte-identical afterwards", async () => {
  const w = world({ obligation_objects: [ART16_EXISTING] });
  const before = structuredClone(ART16_EXISTING);
  await deriveObligationObjects(w.db, { dry: false, itemIds: [F.ETS_ITEM] });
  const objects = w.tables.obligation_objects as Row[];
  assert.ok(objects.some((o) => o.pinpoint_citation === "Article 16(3)" && o.obligation_id !== ART16_EXISTING.obligation_id && o.supersedes === null && o.version === 1));
  assert.deepEqual(objects.find((o) => o.obligation_id === ART16_EXISTING.obligation_id), before);
  assert.deepEqual(w.writes.filter((x) => x.table === "obligation_objects" && x.op !== "insert"), [], "nothing but inserts touched the table");
});

test("the backfill gives an existing object its sanction class from its own span, only where it is null", async () => {
  const w = world({ obligation_objects: [existingObject("cl:obligation:0000000000000001", "Article 16(3)", F.ETS_ITEM, F.ART16_3), existingObject("cl:obligation:0000000000000002", "Article 15(1)", F.ETS_ITEM, "Article 15 Verification 1. Member States shall ensure that reports are verified."), { ...existingObject("cl:obligation:0000000000000003", "Article 16(1)", F.ETS_ITEM, "Member States shall lay down the rules on penalties applicable to infringements"), sanction_class: "administrative" }] });
  const r = await fillObjectFields(w.db, { dry: false, after: null });
  const by = (id: string) => (w.tables.obligation_objects as Row[]).find((o) => o.obligation_id === id);
  assert.equal(by("cl:obligation:0000000000000001")?.sanction_class, "monetary_per_unit");
  assert.equal(by("cl:obligation:0000000000000002")?.sanction_class, null, "a span that is no penalty provision stays null");
  assert.equal(by("cl:obligation:0000000000000003")?.sanction_class, "administrative", "a non-null is never overwritten");
  assert.equal(r.counts.sanction_set, 1);
});

test("D3 at the cause: captureCited stores a page that names one live item by its CELEX with that item, and an already-held unbound capture of the same page is bound by the next call", async () => {
  const eur = "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805";
  const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);
  const f = fixture({ routes: { "https://publications.europa.eu/resource/celex/32023R1805": () => new Response(`${filler}\n${F.ART23_5}\n${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }) } });
  f.db.seed("intelligence_items", [FUELEU]);
  const first = await captureCited(f.d, [{ url: eur, title: "FuelEU Maritime" }], true);
  assert.equal(first.counts.captured, 1, first.notes.join("|"));
  const stored = () => f.db.rows("agent_run_searches").filter((s) => s.result_url === eur);
  assert.deepEqual(stored().map((s) => s.intelligence_item_id), [F.FUELEU_ITEM]);
  stored().forEach((s) => { s.intelligence_item_id = null; });
  const again = await captureCited(f.d, [{ url: eur, title: "FuelEU Maritime" }], true);
  assert.equal(again.counts.unchanged, 1, again.notes.join("|"));
  assert.deepEqual(stored().map((s) => s.intelligence_item_id), [F.FUELEU_ITEM], "the held capture of the same page is bound, not left loose");
});

test("INV-D3-7: a pinpoint that already has an object is not re-spanned or versioned by the penalty paragraphs", async () => {
  const held = existingObject("cl:obligation:0000000000000016", "Article 16(3)", F.ETS_ITEM, "3. Member States shall ensure that any operator who does not surrender sufficient allowances shall be held liable");
  const w = world({ obligation_objects: [held] });
  const before = structuredClone(held);
  const r = await deriveObligationObjects(w.db, { dry: false, itemIds: [F.ETS_ITEM] });
  const objects = (w.tables.obligation_objects as Row[]).filter((o) => o.pinpoint_citation === "Article 16(3)");
  assert.equal(objects.length, 1, r.notes.join("|"));
  assert.deepEqual(objects[0], before);
});

test("run what is built: the connect stage binds the loose capture, then its reading derives the penalty objects of the bound capture's item and records the item as read; a second reading adds nothing (the ruled plan's steps)", async () => {
  const f = fixture();
  f.db.seed("intelligence_items", [ETS]);
  f.db.seed("agent_run_searches", [capture("00000000-0000-4000-8000-00000000c201", null, F.ETS_TEXT, { result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02003L0087-20240301" })]);
  const step = (dry: boolean, scan_limit: number) => runConnect({ mode: dry ? "dry" : "apply", dry, input: { scan_limit }, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", upstream: null } as never, f.d);
  const bindDry = await step(true, 0);
  assert.equal(bindDry.counts.unbound, 1);
  assert.equal(f.db.rows("agent_run_searches").find((c) => c.id === "00000000-0000-4000-8000-00000000c201")?.intelligence_item_id ?? null, null, "dry binds nothing");
  const bind = await step(false, 0);
  assert.equal(bind.counts.bound, 1, bind.notes.join("|"));
  assert.equal(f.db.rows("obligation_objects").filter((o) => o.instrument_item_id === F.ETS_ITEM).length, 0, "scan_limit 0 reads no backlog");
  const derive = await step(false, 500);
  const pins = f.db.rows("obligation_objects").filter((o) => o.instrument_item_id === F.ETS_ITEM).map((o) => o.pinpoint_citation);
  assert.ok(["Article 16(3)", "Article 16(3a)"].every((p) => pins.includes(p)), `${pins.join(",")}; ${derive.notes.join("|")}`);
  assert.equal(f.db.rows("item_obligation_scan").filter((s) => s.item_id === F.ETS_ITEM).length, 1, "the item is recorded as read at the new derivation version");
  const count = f.db.rows("obligation_objects").length;
  await step(false, 500);
  assert.equal(f.db.rows("obligation_objects").length, count);
});

test("the statute grammar is data: a UK Schedule's Part and paragraphs and a US section's clauses are read like an Article's (pinpoints), and a penalty paragraph with no holder anywhere in its instrument is refused with the reason", async () => {
  const UK = "Article 1 Scope 1. Operators shall keep the records. Regulation 19 SCHEDULE 2 Civil sanctions PART 1 Fixed monetary penalties 1. —(1) The amount of a fixed monetary penalty under these Regulations is £1,000. (2) A fixed monetary penalty may not be imposed on a person on more than one occasion in relation to the same act or omission. 2. —(1) Where the Agency proposes to impose a fixed monetary penalty on a person, the Agency must serve on that person a notice of its intention to do so.";
  const US = "§ 1.2 Penalties. (a) Any person who violates this part shall be subject to a civil penalty of up to $100,000 per violation. (b) The Administrator may compromise a penalty.";
  const uk = item("00000000-0000-4000-8000-00000000f0b1", { title: "The Digital Waste Tracking Regulations", instrument_identifier: "SI 2026/9" });
  const us = item("00000000-0000-4000-8000-00000000f0b2", { title: "A federal part", instrument_identifier: "49 CFR 1" });
  const w = world({ intelligence_items: [uk, us], agent_run_searches: [capture("00000000-0000-4000-8000-00000000c301", String(uk.id), UK), capture("00000000-0000-4000-8000-00000000c302", String(us.id), US)] });
  const plan = planOf(await deriveObligationObjects(w.db, { dry: true, itemIds: [String(uk.id), String(us.id)] }));
  assert.equal(rowOf(plan, String(uk.id), "Schedule 2 Part 1(1)").sanction_class, "monetary_fixed");
  assert.ok(plan.refused.some((r) => r.pinpoint_citation === "Schedule 2 Part 1(2)" && r.reason === "penalty_word_without_trigger"));
  assert.ok(plan.refused.some((r) => r.instrument_item_id === String(us.id) && r.pinpoint_citation === "§ 1.2(a)" && r.reason === "duty_holder_unresolved"), JSON.stringify(plan.refused));
});
