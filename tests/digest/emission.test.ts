// The reader's emission contract (DIGEST-1 PR B, UNIFIED-PRB-DESIGN section 1): the typed blocks of an item-brief entry are validated before any write and applied through the tables the flywheel joins on. Each contract check is attacked
// with one planted violation; INV-DIG-2 (an altered quote) is refused by the validator AND by the write path; INV-DIG-5 (the blocks reach their tables and the downstream fires) runs the whole entry through the batch kit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { READER_METHOD } from "@/core/digest/kinds";
import { proposedEntityId } from "@/core/vocabulary/adopted";
import { applyBatch } from "@/features/batches";
import { loadEmit, writeEmission } from "@/features/batches/kinds/item-briefs/emit";
import { validateEmission, type EmissionPlan } from "@/features/batches/kinds/item-briefs/emission";

import { batchFile, ITEM, NOW } from "../batches/world.ts";

import { emissionEntry, emissionWorld, HVO, OCEAN, ORG, SELF, UCO, type EmissionWorld } from "./emission-world.ts";

const live = async (w: EmissionWorld, e: Record<string, unknown>) => loadEmit(w.deps, ITEM, [...JSON.stringify(e).matchAll(/CELEX:\w+/g)].map((m) => m[0]));
const check = async (w: EmissionWorld, e: Record<string, unknown>) => validateEmission(e, "item X", await live(w, e));
const apply = (w: EmissionWorld, e: Record<string, unknown>, dry = false) => applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", [e])), dry, runId: "r1" });
const reasons = (r: { errors: string[] }) => r.errors.join("\n");

test("a full entry validates: every quote is located, every id resolved, every closed token and date checked; the plan carries the capture's own slices", async () => {
  const w = emissionWorld();
  const r = await check(w, emissionEntry(w));
  assert.deepEqual(r.errors, []);
  const plan = r.plan as EmissionPlan;
  assert.deepEqual(plan.entities.map((e) => e.entity_id), [SELF, HVO, SELF], "a formal code resolves to the instrument entity through the crosswalk");
  assert.equal(plan.entities[1]?.quote.text, "Hydrotreated vegetable oil", "the quote is stored as the capture's own words, whitespace as the capture has it");
  assert.deepEqual(plan.objects.map((o) => [o.pinpoint, Object.keys(o.set).sort().join(",")]), [["Article 3", "applicability_trigger,binding_position,duty_holder_class,mode,sanction_class,statutory_maximum"], ["Article 5", "applicability_trigger,binding_position,due_date,duty_holder_class,mandated_quantity,mandated_unit"]]);
  assert.equal(plan.objects[1]?.set.mandated_unit, "MW");
  assert.equal(plan.connections[0]?.relation, "feedstock_of");
});

test("INV-DIG-2: an altered quote is refused by the validator in every block, and a provision the capture does not hold writes nothing at the write path", async () => {
  const w = emissionWorld();
  const altered = (text: string) => ({ capture_id: w.cap, text });
  for (const [what, over] of [
    ["entity_ids", { entity_ids: [{ entity_id: HVO, quote: altered("Hydrotreated vegetable petrol") }] }],
    ["obligation provision", { obligation_fields: [{ pinpoint: "Article 3", provision: altered("A penalty of up to EUR 51 000 shall apply"), fields: {} }] }],
    ["obligation field", { obligation_fields: [{ pinpoint: "Article 5", provision: altered("Each Member State shall make available at least 50 MW"), fields: { mandated_quantity: { value: { value: 50, unit: "MW" }, quote: altered("at least 55 MW of charging capacity") } } }] }],
    ["connection", { connections: [{ from_entity_id: UCO, to_entity_id: HVO, relation: "feedstock_of", reason_token: "named_feedstock", quote: altered("which is its secondary feedstock") }] }],
    ["event", { events: [{ event_kind: "entry_into_force", event_date: "2027-01-01", quote: altered("This Regulation shall enter into force on 2 January 2027") }] }],
    ["document_date", { document_date: { date: "2023-09-13", quote: altered("Done at Brussels, 13 September 2023.") } }],
    ["candidate", { new_entity_candidates: [{ proposed_kind: "organisation", canonical_name: "Maersk Line A/S", quote: altered("Maersk Line A/S sails the service") }] }],
  ] as const) {
    const r = await check(w, emissionEntry(w, over as Record<string, unknown>));
    assert.match(reasons(r), /the quote is not in capture/, what);
    assert.equal(r.plan, null, what);
  }
  const wrong = await check(w, emissionEntry(w, { entity_ids: [{ entity_id: HVO, quote: { capture_id: "00000000-0000-4000-8000-000000000000", text: "Hydrotreated vegetable oil" } }] }));
  assert.match(reasons(wrong), /not a capture of this item/);
  const readerRows = () => w.db.rows("obligation_objects").filter((o) => o.method_version === READER_METHOD).length;
  const plan = ((await check(w, emissionEntry(w))).plan) as EmissionPlan;
  const forged = { ...plan, objects: [{ ...(plan.objects[0] as EmissionPlan["objects"][number]), provision: { capture_id: w.cap, text: "A penalty of up to EUR 51 000 shall apply to an operator" } }], entities: [], connections: [], events: [], document_date: null, candidates: [] };
  const out = await writeEmission(w.deps, ITEM, null, forged, new Set([w.cap]));
  assert.equal(readerRows(), 0, "the derive's own guard refused a provision that is not verbatim in the capture");
  assert.match(out.notes.join(), /span_not_verbatim/);
});

test("the contract checks: an id outside the menu, a candidate used as an id, an unlisted relation, a blank-field object, a date without a quote, a date the quote does not state", async () => {
  const w = emissionWorld();
  const q = (text: string) => ({ capture_id: w.cap, text });
  const outside = entityId16("cl:organisation:", "feedfeedfeedfeed");
  assert.match(reasons(await check(w, emissionEntry(w, { entity_ids: [{ entity_id: outside, quote: q("Strasbourg") }] }))), new RegExp(`unknown entity id "${outside}"`));
  const asId = proposedEntityId("organisation", "maersk line a/s");
  assert.match(reasons(await check(w, emissionEntry(w, { entity_ids: [{ entity_id: asId, quote: q(ORG) }] }))), /a candidate is never usable in entity_ids in the same entry/);
  assert.match(reasons(await check(w, emissionEntry(w, { connections: [{ from_entity_id: UCO, to_entity_id: HVO, relation: "likes", reason_token: "named_feedstock", quote: q("Hydrotreated vegetable oil is produced from used cooking oil") }] }))), /relation \(feedstock_of/);
  const bare = { pinpoint: "Article 9", provision: q("Operators shall report verified annual emissions"), fields: { statutory_maximum: { value: "EUR 50 000", quote: q("EUR 50 000") } } };
  const refused = reasons(await check(w, emissionEntry(w, { obligation_fields: [bare] })));
  for (const need of ["duty_holder_class", "binding_position", "applicability_trigger"]) assert.match(refused, new RegExp(`a new object needs ${need}`));
  assert.match(reasons(await check(w, emissionEntry(w, { document_date: { date: "2023-09-13" } }))), /document date without a quote is refused/);
  assert.match(reasons(await check(w, emissionEntry(w, { document_date: { date: "2023-09-14", quote: q("Done at Strasbourg, 13 September 2023.") } }))), /2023-09-14 is not stated in the quote/);
  assert.match(reasons(await check(w, emissionEntry(w, { new_entity_candidates: [{ proposed_kind: "port", canonical_name: "Rotterdam", quote: q("the port of Rotterdam NLRTM") }] }))), /UN\/LOCODE/);
  assert.match(reasons(await check(w, emissionEntry(w, { entity_ids: [{ entity_id: "CELEX:32099R0000", quote: q("Strasbourg") }] }))), /unknown entity id "CELEX:32099R0000"/);
  assert.match(reasons(await check(w, emissionEntry(w, { obligation_fields: [{ pinpoint: "Article 5", provision: q(ORG), fields: { sanction_class: { value: "fine", quote: q(ORG) } } }] }))), /sanction_class "fine" is not a closed token/);
});
const entityId16 = (prefix: string, hex: string): string => `${prefix}${hex}`;

test("a locate door that is not wired refuses an entry with typed blocks and leaves an entry without them alone", async () => {
  const w = emissionWorld();
  const unwired = { ...w.deps, locate: null };
  const e = emissionEntry(w);
  const r = validateEmission(e, "item X", await loadEmit(unwired, ITEM, []));
  assert.match(reasons(r), /locate door is not wired/);
  assert.deepEqual(validateEmission({ item_id: ITEM }, "item X", await loadEmit(unwired, ITEM, [])), { errors: [], plan: null });
});

test("INV-DIG-5: the entry applies end to end: the blocks reach their tables with the reader's version and their quotes, the downstream passes run, and a second apply writes nothing", async () => {
  const w = emissionWorld();
  const e = emissionEntry(w);
  const dry = await apply(w, e, true);
  assert.equal(dry.counts.valid, 1, dry.notes.join("\n"));
  assert.equal(w.db.rows("entity_refs").length + w.db.rows("obligation_objects").length + w.db.rows("entity_relations").length + w.db.rows("vocabulary_terms").length, 0, "a dry run wrote nothing");
  const r = await apply(w, e);
  assert.equal(r.counts.applied, 1, r.notes.join("\n"));
  assert.equal((r.data as { downstream: { counts: Record<string, number> } }).downstream.counts.flywheel_passes, 3, "the tag, term and corpus passes ran after the batch");
  const reader = (row: Record<string, unknown>) => row.method_version === READER_METHOD;
  // entities and the objects' entities and the event's entity and mode, each a typed ref carrying the quote
  const refs = w.db.rows("entity_refs").filter((x) => x.asserted_by === "reader");
  assert.deepEqual(refs.filter((x) => x.ref_table === "intelligence_items").map((x) => x.entity_id).sort(), [HVO, SELF].sort(), "the same entity named twice is filed once");
  assert.ok(refs.every(reader) && refs.every((x) => typeof (x.basis as { quote?: string }).quote === "string"));
  assert.ok(refs.some((x) => x.ref_table === "obligation_objects" && x.entity_id === HVO));
  assert.deepEqual(refs.filter((x) => x.ref_table === "item_forward_events").map((x) => x.entity_id).sort(), [HVO, OCEAN].sort(), "the event is filed under its entity and its mode token");
  // obligation objects through the derive's own row builder
  const objs = w.db.rows("obligation_objects").filter(reader);
  assert.deepEqual(objs.map((o) => o.pinpoint_citation).sort(), ["Article 3", "Article 5"]);
  const a5 = objs.find((o) => o.pinpoint_citation === "Article 5") as Record<string, unknown>;
  assert.deepEqual([a5.mandated_quantity, a5.mandated_unit, a5.due_date, a5.binding_position, a5.duty_holder_class], [50, "MW", "2027-01-01", "direct_duty", ["member_state"]]);
  const a3 = objs.find((o) => o.pinpoint_citation === "Article 3") as Record<string, unknown>;
  assert.deepEqual([a3.statutory_maximum, a3.sanction_class, a3.mode], ["EUR 50 000", "monetary_capped", ["ocean"]]);
  assert.equal((a3.basis as { quotes: Record<string, { text: string }> }).quotes.statutory_maximum?.text, "A penalty of up to EUR 50 000");
  // the connection, the event, the document date, the candidate and the review
  const rel = w.db.rows("entity_relations").filter(reader);
  assert.deepEqual(rel.map((x) => [x.parent_entity_id, x.child_entity_id, x.relation, x.asserted_by]), [[UCO, HVO, "feedstock_of", "reader"]]);
  assert.equal((rel[0]?.basis as { reason_token: string }).reason_token, "named_feedstock");
  const ev = w.db.rows("item_forward_events").filter((x) => x.extractor_version === READER_METHOD);
  assert.deepEqual(ev.map((x) => [x.source_kind, x.source_capture_id, x.event_date, x.confidence]), [["capture", w.cap, "2027-01-01", "medium"]]);
  const cap = w.db.rows("agent_run_searches").find((x) => x.id === w.cap) as Record<string, unknown>;
  assert.deepEqual([cap.document_date, cap.document_date_method], ["2023-09-13", READER_METHOD]);
  const term = w.db.rows("vocabulary_terms").find((x) => x.label === "Maersk Line A/S") as { status: string; kind: string; evidence: { proposed_kind: string } };
  assert.deepEqual([term.status, term.kind, term.evidence.proposed_kind], ["proposed", "term", "organisation"]);
  assert.equal(w.db.rows("vocabulary_mentions").filter((m) => m.surface_text === ORG).length, 1);
  assert.equal(w.db.rows("brief_reviews").length, 1);
  assert.equal(w.db.rows("entities").some((x) => String(x.canonical_name) === "Maersk Line A/S"), false, "a candidate is never minted inline");
  // idempotence: the same plan again writes zero new rows
  const before = ["entity_refs", "obligation_objects", "entity_relations", "item_forward_events", "vocabulary_terms", "vocabulary_mentions"].map((t) => w.db.rows(t).length);
  const plan = (await check(w, e)).plan as EmissionPlan;
  const again = await writeEmission(w.deps, ITEM, null, plan, new Set([w.cap]));
  assert.deepEqual(["entity_refs", "obligation_objects", "entity_relations", "item_forward_events", "vocabulary_terms", "vocabulary_mentions"].map((t) => w.db.rows(t).length), before, JSON.stringify(again));
  assert.equal(again.counts.objects_written ?? 0, 0);
  assert.equal(again.counts.refs_written ?? 0, 0);
});

test("a reader value supersedes a derived one per column, and a derived value never overwrites a reader value (attack both ways)", async () => {
  const w = emissionWorld();
  const { deriveObligationObjects } = await import("@/features/obligations");
  // a derived object for Article 3 (no method version), carrying a figure and a class the reader will keep or replace
  const derived = { instrument_item_id: ITEM, capture_id: w.cap, pinpoint_citation: "Article 3", verbatim_text: "A penalty of up to EUR 50 000 shall apply to an operator that fails to report within the period set out in Article 2.", duty_holder_class: ["operator"], binding_position: "direct_duty", applicability_trigger: { attribute: "instrument", value: "2023/9999" }, statutory_maximum: "EUR 50 000", sanction_class: "monetary_fixed" };
  const first = await deriveObligationObjects(w.db.client, { dry: false, itemIds: [ITEM], extraCandidates: [derived] });
  assert.equal(first.data?.plan.toInsert.filter((p) => p.row.pinpoint_citation === "Article 3").length, 1, JSON.stringify(first.data?.plan.refused));
  await apply(w, emissionEntry(w));
  const a3 = w.db.rows("obligation_objects").filter((o) => o.pinpoint_citation === "Article 3");
  assert.deepEqual(a3.map((o) => [o.version, o.method_version ?? null]), [[1, null], [2, READER_METHOD]], "the reader's row is the next version of the derived one");
  const v2 = a3.find((o) => o.version === 2) as Record<string, unknown>;
  assert.equal(v2.supersedes, (a3.find((o) => o.version === 1) as Record<string, unknown>).obligation_id);
  assert.equal(v2.sanction_class, "monetary_capped", "the reader's class replaced the derived class");
  // a derived candidate with different text for the same pinpoint is refused as already registered: it cannot overwrite the reader's row
  const redo = await deriveObligationObjects(w.db.client, { dry: false, itemIds: [ITEM], extraCandidates: [{ ...derived, verbatim_text: "A penalty of up to EUR 50 000 shall apply to an operator that fails to report", sanction_class: "monetary_fixed" }] });
  assert.equal(redo.data?.plan.toInsert.filter((p) => p.row.pinpoint_citation === "Article 3").length, 0);
  assert.equal(w.db.rows("obligation_objects").filter((o) => o.pinpoint_citation === "Article 3").length, 2);
  assert.equal(((w.db.rows("obligation_objects").filter((o) => o.pinpoint_citation === "Article 3" && o.version === 2)[0]) as Record<string, unknown>).sanction_class, "monetary_capped");
  void NOW;
});

test("the new-entity path fired once on a fixture: a proposed organisation recurs in two items from two sources, the recurrence rule adopts it, and the adopted entity mints with the reader's kind", async () => {
  const w = emissionWorld();
  await apply(w, emissionEntry(w));
  const { termPass } = await import("@/features/flywheel");
  const second = "a0000000-0000-4000-8000-000000000002";
  w.db.seed("intelligence_items", [{ id: second, title: "Second", item_type: "market_signal", item_grade: "brief", provenance_status: "verified", is_archived: false, source_id: "b0000000-0000-4000-8000-000000000002", source_url: "https://example-news.test/x" }]);
  const term = w.db.rows("vocabulary_terms").find((x) => x.label === "Maersk Line A/S") as { id: string };
  w.db.seed("vocabulary_mentions", [{ term_id: term.id, item_id: second, source_id: "b0000000-0000-4000-8000-000000000002", detector: "brief-terms", surface_text: "Maersk Line A/S sails it" }]);
  const r = await termPass({ sb: w.db.client, now: () => NOW }, { dry: false, minItems: 2 });
  assert.equal(r.counts.newly_adopted, 1, r.notes.join("; "));
  const row = w.db.rows("vocabulary_terms").find((x) => x.id === term.id) as { status: string; evidence: { proposed_kind: string } };
  assert.deepEqual([row.status, row.evidence.proposed_kind], ["adopted", "organisation"], "the proposed kind survives the recount");
  const minted = w.db.rows("entities").find((x) => x.canonical_name === "Maersk Line A/S") as { kind: string; entity_id: string };
  assert.equal(minted.kind, "organisation");
  assert.match(minted.entity_id, /^cl:organisation:[0-9a-f]{16}$/);
});
