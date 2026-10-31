// The three planted triangles of TRIANGLE-TRACE Q2 on an isolated fixture database (CONNECT-2 PR B, unified design section 4). Test values only: every number below is a fixture number, none is a real fact. The rows are the minimal rows of the trace's fixture specs; the refs the reader's `entity_ids`
// would file them under (DIGEST-1 PR B's apply) are planted as entity_refs rows with a reader method_version and a basis; the refs the typed columns give are mined by the connect stage, and the relations are the seeded couplings plus the lane's corridor_links edge (JOIN-1 J2).
import { uuidOf } from "@/core/coupling";

import { roleOf } from "../_support/ontology.ts";
import { fixture, NOW, type Fixture } from "../integration/world.ts";
import type { Row } from "../_support/memdb.ts";

import { E } from "./_world.ts";

export const day = (n: number): string => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const uuid = (n: number): string => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const LANE = "cl:corridor:b624b607add73ba4";
export const ITEM = { ets: uuid(1), fueleu: uuid(2), afir: uuid(3), research: uuid(4) };
export const OBL = { ceiling: "cl:obligation:00000000000000c1", fueleu: "cl:obligation:00000000000000c2", afir: "cl:obligation:00000000000000c3", ended: "cl:obligation:00000000000000c4" };
export const ROW = { trigger: uuid(10), reroute: uuid(11), queue: uuid(12), roadmapSaf: uuid(13), roadmapMw: uuid(14), assessment: uuid(15), abatement: uuid(16), seriesA: uuid(17), seriesB: uuid(18) };
const SRC = "b2000000-0000-4000-8000-000000000001";
const item = (id: string, title: string, status: string): Row => ({ id, title, item_type: "regulation", domain: 1, provenance_status: status, is_archived: false, added_date: day(-400), operational_scenario_tags: [], compliance_object_tags: [], topic_tags: [], jurisdiction_iso: [] });
const object = (id: string, itemId: string, entity: string, over: Row): Row => ({ obligation_id: id, instrument_item_id: itemId, instrument_entity_id: entity, pinpoint_citation: "Article 1", verbatim_text: "fixture verbatim text", binding_position: "direct_duty", duty_holder_class: ["carrier"], applicability_trigger: {}, capture_id: uuid(90), source_id: SRC, ...over });
const reader = (table: string, key: string, entity: string, quote: string): Row => ({ ref_table: table, ref_id: /^[0-9a-f]{8}-/.test(key) ? key : uuidOf(key), entity_id: entity, role: roleOf(entity), asserted_by: "reader/item-briefs", basis: { quote, capture_id: uuid(90) }, method_version: "reader@fixture" });

/** Plant the rows of the three triangles into the fixture database (before the connect stage mines the typed refs). */
export function plantTriangles(f: Fixture, over: { endedCeiling?: boolean } = {}): void {
  const db = f.db;
  db.seed("intelligence_items", [item(ITEM.ets, "fixture ETS", "verified"), item(ITEM.fueleu, "fixture FuelEU Maritime", "quarantined"), item(ITEM.afir, "fixture AFIR", "quarantined"), item(ITEM.research, "fixture research", "verified")]);
  db.rows("entities").push({ entity_id: LANE, kind: "corridor", canonical_name: "CNSHA-ITGOA:ocean", status: "active" });
  db.seed("obligation_objects", [
    // Triangle 1: the ETS Article 16(3) ceiling (P5) and the FuelEU Article 4 step 36 days out under Bio-bunkers (P4 start); Triangle 2: the AFIR HDV step 14 months out under HDV charging (P2)
    object(OBL.ceiling, ITEM.ets, E("instrument:32003L0087"), { pinpoint_citation: "Article 16(3)", statutory_maximum: "EUR 100 for each tonne of carbon dioxide equivalent", mode: ["air", "ocean"] }),
    object(OBL.fueleu, ITEM.fueleu, E("instrument:32023R1805"), { pinpoint_citation: "Article 4", due_date: day(36), mode: ["ocean"] }),
    object(OBL.afir, ITEM.afir, E("instrument:32023R1804"), { pinpoint_citation: "Article 4", due_date: new Date(Date.UTC(2027, 11, 15)).toISOString().slice(0, 10), mode: ["road"] }),
    ...(over.endedCeiling ? [object(OBL.ended, ITEM.ets, E("instrument:32003L0087"), { pinpoint_citation: "Article 16(4)", statutory_maximum: "EUR 40 for each tonne of carbon dioxide equivalent", enforcement_start: "2005-01-01", in_force_end: "2007-12-31", mode: ["air", "ocean"] })] : []),
  ]);
  db.seed("research_assessments", [{ id: ROW.assessment, item_id: ITEM.research, is_current: true, technical_maturity_low: 9, technical_maturity_high: 9, entity_id: E("carrier:hefa_saf"), computed_at: `${day(-5)}T09:00:00Z` }]);
  db.seed("derived_values", [{ value_id: ROW.abatement, entity_id: E("carrier:hefa_saf"), method_id: "fixture_abatement", method_version: "1", value: 1250, unit: "EUR/tCO2e", currency: "EUR", derivation: "calculated", origin_class: "derived", lifecycle: "corroborated", admissibility: "analysis_ok", base_confidence: 0.6, asserted_at: `${day(-5)}T09:00:00Z`, inputs: [], computed_by: "fixture" }]);
  db.seed("oem_tech_roadmaps", [
    { roadmap_id: ROW.roadmapSaf, manufacturer_id: null, tech_category: "saf_refinery", commercial_stage: "announced", target_year: null, announced_at: day(-20), source_id: SRC, origin_class: "official", derivation: "assessed" },
    { roadmap_id: ROW.roadmapMw, manufacturer_id: null, tech_category: "megawatt_charging", commercial_stage: "pilot_demonstration", target_year: 2029, announced_at: "2024-09-15", source_id: SRC, origin_class: "official", derivation: "assessed" },
  ]);
  db.seed("grid_connection_queues", [{ queue_id: ROW.queue, jurisdiction_id: null, dso_name: "fixture DSO", queue_months_p50: 30, as_of: "2026-05-29", demand_available_mw: 11.9, source_id: SRC, origin_class: "official", derivation: "observed" }]);
  // Triangle 3: a phase step 68 days out, a reroute 36 days ago and two rate points on the lane
  db.seed("item_forward_events", [{ id: ROW.trigger, intelligence_item_id: ITEM.ets, event_date: day(68), date_precision: "day", event_kind: "phase_step", obligation_text: "fixture maritime step", source_kind: "capture", source_capture_id: uuid(90), source_span: "fixture", confidence: "medium", extractor_version: "fixture", created_at: `${day(-25)}T09:00:00Z` }]);
  db.seed("reroute_events", [{ reroute_id: ROW.reroute, baseline_corridor_id: LANE, reroute_corridor_id: LANE, route_via: "suez", effective_from: day(-36), source_id: SRC }]);
  const point = (id: string, value: number, at: string): Row => ({ id, series_key: "drewry-wci:cnsha-itgoa", label: "fixture lane rate", entity_id: LANE, value_numeric: value, unit: "USD/FEU", currency: "USD", derivation: "observed", origin_class: "official", source_key: "fixture", source_ref: "fixture", as_at_date: at, reference_period: at });
  db.seed("market_series", [point(ROW.seriesA, 4400, day(-23)), point(ROW.seriesB, 4950, day(-2))]);
}

/** After the connect stage has mined the refs: the refs the reader's entity_ids would file (the carrier under the FuelEU step, the node under the AFIR step, the instrument and the mode under the maritime trigger), and the lane's corridor_links edge to its mode. */
export function plantReaderRefs(f: Fixture): void {
  f.db.rows("entity_refs").push(...[
    // the technology categories and the grid queue are words and codes the engine maps to nothing: the Reader files them
    reader("oem_tech_roadmaps", ROW.roadmapSaf, E("carrier:hefa_saf"), "fixture quote: saf refinery"),
    reader("oem_tech_roadmaps", ROW.roadmapMw, E("node:hdv_charging"), "fixture quote: megawatt charging"),
    reader("grid_connection_queues", ROW.queue, E("node:grid_queues"), "fixture quote: grid queue"),
    // the ETS ceiling prices the fuel the abatement cost is for: the Reader files it under that fuel, so the join is a specific entity and not the mode both are filed under
    reader("obligation_objects", OBL.ceiling, E("carrier:hefa_saf"), "fixture quote: ETS prices SAF"),
    reader("obligation_objects", OBL.fueleu, E("carrier:bio_bunkers"), "fixture quote: Bio-bunkers"),
    reader("obligation_objects", OBL.afir, E("node:hdv_charging"), "fixture quote: HDV charging"),
    reader("item_forward_events", ROW.trigger, E("instrument:32003L0087"), "fixture quote: ETS"),
    reader("item_forward_events", ROW.trigger, E("mode:ocean"), "fixture quote: maritime"),
  ]);
  f.db.rows("entity_relations").push({ parent_entity_id: LANE, child_entity_id: E("mode:ocean"), relation: "corridor_links", asserted_by: "fixture-modeLinks" });
}

export function triangleFixture(over: { endedCeiling?: boolean } = {}): Fixture {
  const f = fixture();
  plantTriangles(f, over);
  return f;
}
