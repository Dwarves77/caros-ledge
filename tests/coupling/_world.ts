// The CONNECT-2 world: the integration fixture (real wiring, real stages, the coupling pages served by the fixture transport) plus the data that yields exactly one pattern of each kind and one cross-modal pattern per relation kind. Every number is a fixture number; the entities are the
// seeded couplings, looked up by key. The data plants nothing the detectors do not read from a table: claims, obligations, a roadmap row, a forward event, three series, a research assessment, a statutory computation and a derived abatement cost.
import { couplingByKey } from "@/core/coupling";
import { runTurn } from "@/core/turn";

import { fixture, NOW, type Fixture } from "../integration/world.ts";
import type { Row } from "../_support/memdb.ts";

export { NOW };
export const E = (key: string): string => (couplingByKey(key) as { entityId: string }).entityId;
export const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
const uuid = (n: number): string => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TYPE = { reg: ["regulation", 1], market: ["market_signal", 3], research: ["research_finding", 7] } as const;
let c = 100;
const src = (n: number): string => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const point = (n: number, label: string, key: string, value: number, at: string): Row => ({ id: uuid(300 + n), series_key: key, label, value_numeric: value, unit: "EUR/t", currency: "EUR", derivation: "observed", origin_class: "official", source_key: "fixture", source_ref: "fixture", as_at_date: at, reference_period: at });
/** A claim and the item it belongs to. The item carries the day the knowledge entered the corpus (added_date), which is the day the claim counts from; the claim's own extraction time is a later backfill. */
export function claimWithItem(type: keyof typeof TYPE, text: string, added: string, source: string, tier: number | null, kind = "FACT", id = uuid(++c)): { item: Row; claim: Row } {
  const itemId = uuid(1000 + c);
  return {
    item: { id: itemId, title: `fixture ${type} ${c}`, item_type: TYPE[type][0], domain: TYPE[type][1], provenance_status: "unverified", is_archived: false, added_date: added, operational_scenario_tags: [], compliance_object_tags: [], topic_tags: [], jurisdiction_iso: [] },
    claim: { id, intelligence_item_id: itemId, claim_text: text, claim_kind: kind, source_span: text, source_id: source, source_tier_at_grounding: tier, extracted_at: `${ago(0)}T09:00:00Z` },
  };
}
export const ITEM = { reg: uuid(1), market: uuid(2), research: uuid(3) };
const item = (id: string, type: keyof typeof TYPE): Row => ({ id, title: `fixture ${type}`, item_type: TYPE[type][0], domain: TYPE[type][1], provenance_status: "unverified", is_archived: false, added_date: ago(400), operational_scenario_tags: [], compliance_object_tags: [], topic_tags: [], jurisdiction_iso: [] });
/** A claim on one of the three fixed items, which were added long before the window: it counts from the item's day, not from its extraction. */
export const claim = (item_id: string, text: string, extracted: string, source: string, tier: number | null, kind = "FACT", id = uuid(++c)): Row => ({ id, intelligence_item_id: item_id, claim_text: text, claim_kind: kind, source_span: text, source_id: source, source_tier_at_grounding: tier, extracted_at: `${extracted}T09:00:00Z` });

export const HVO_CLAIM = uuid(900);
export const OBLIGATION = { air: "cl:obligation:00000000000000a1", ocean: "cl:obligation:00000000000000a2", road: "cl:obligation:00000000000000a4", uco: "cl:obligation:00000000000000a6" };

/** Plant the data of the five patterns (and of the four relation kinds of the cross-modal one) into the fixture database. */
export function plant(f: Fixture): void {
  const db = f.db;
  const rows = [
    // P1: three independent sources of three tiers on one carrier in the last 30 days, and three older claims as its baseline
    claimWithItem("reg", "Green ammonia offtake agreements were announced by three producers.", ago(5), src(1), 1),
    claimWithItem("market", "Green ammonia offtake agreements were announced by three producers.", ago(9), src(2), 2),
    claimWithItem("research", "Green ammonia offtake agreements were announced by three producers.", ago(14), src(3), 3),
    ...[120, 125, 130].map((d, n) => claimWithItem("reg", "Green ammonia offtake agreements were announced by three producers.", ago(d), src(4 + n * 40), 1)),
    // the claim a pending trigger rests on, and the recent rows the cross-modal cases land on
    claimWithItem("reg", "Hydrotreated vegetable oil deliveries to road fleets widened.", ago(200), src(5), 1, "FACT", HVO_CLAIM),
    claimWithItem("market", "Lignocellulosic residues were contracted for methanol output.", ago(10), src(6), 2),
    claimWithItem("market", "HEFA output rose at two refiners.", ago(10), src(7), 2),
    claimWithItem("market", "HDV charging sites opened at two depots.", ago(10), src(8), 2),
    claimWithItem("market", "Sea-air capacity tightened on the Gulf lanes.", ago(10), src(9), 2),
    // the landings of the mode-agnostic mandate and of the two corridors that now link road
    claimWithItem("market", "The PPWR sets recycled packaging duties for every consignment.", ago(10), src(10), 2),
    claimWithItem("market", "Modal shift to rail was announced for the Alpine corridor.", ago(10), src(11), 2),
    claimWithItem("market", "Modal shift to inland waterways was announced for the Rhine.", ago(10), src(12), 2),
    // the corpus's flow: claims that name nothing in the vocabulary, before and after the window
    ...Array.from({ length: 12 }, (_, n) => claimWithItem("reg", "General background with no coupling named.", ago(60 + n * 7), src(30 + n), 1)),
  ];
  db.seed("intelligence_items", [item(ITEM.reg, "reg"), item(ITEM.market, "market"), item(ITEM.research, "research"), ...rows.map((r) => r.item)]);
  db.seed("section_claim_provenance", rows.map((r) => r.claim));
  db.seed("obligation_objects", [
    // P2: a dated ratchet of the ReFuelEU instrument; P4 (corridor_links): an ocean-wide ratchet inside the recency window
    { obligation_id: OBLIGATION.air, instrument_item_id: ITEM.reg, instrument_entity_id: E("instrument:32023R2405"), first_deadline: new Date(NOW.getTime() + 100 * 86_400_000).toISOString().slice(0, 10), mode: ["air"], applicability_trigger: {} },
    { obligation_id: OBLIGATION.ocean, instrument_item_id: ITEM.reg, instrument_entity_id: null, first_deadline: new Date(NOW.getTime() + 30 * 86_400_000).toISOString().slice(0, 10), mode: ["ocean"], applicability_trigger: {} },
    // a road-wide ratchet inside the recency window (P4 over the road links), and a duty whose own text names a seeded feedstock and no entity column does (P2 through the verbatim text)
    { obligation_id: OBLIGATION.road, instrument_item_id: ITEM.reg, instrument_entity_id: null, first_deadline: new Date(NOW.getTime() + 30 * 86_400_000).toISOString().slice(0, 10), mode: ["road"], applicability_trigger: {} },
    { obligation_id: OBLIGATION.uco, instrument_item_id: ITEM.reg, instrument_entity_id: null, first_deadline: new Date(NOW.getTime() + 100 * 86_400_000).toISOString().slice(0, 10), mode: [], verbatim_text: "Operators shall source used cooking oil only from certified collectors.", applicability_trigger: {} },
  ]);
  db.seed("oem_tech_roadmaps", [{ roadmap_id: uuid(400), manufacturer_id: null, tech_category: "saf_refinery", commercial_stage: "announced", target_year: 2029, announced_at: null, source_id: src(20), origin_class: "official", derivation: "assessed" }]);
  db.seed("item_forward_events", [{ id: uuid(500), intelligence_item_id: ITEM.reg, event_date: new Date(NOW.getTime() + 100 * 86_400_000).toISOString().slice(0, 10), date_precision: "day", event_kind: "phase_step", obligation_text: "next phase", source_kind: "claim", source_claim_id: HVO_CLAIM, source_span: "x", confidence: "high", extractor_version: "fixture" }]);
  db.seed("market_series", [
    point(1, "Hydrotreated vegetable oil spot price", "fixture:hvo-spot", 100, ago(70)), point(2, "Hydrotreated vegetable oil spot price", "fixture:hvo-spot", 110, ago(10)),
    point(3, "Bio-methanol price", "fixture:bio-methanol", 200, ago(60)), point(4, "Bio-methanol price", "fixture:bio-methanol", 220, ago(10)),
    point(5, "Shore power tariff", "fixture:shore-power", 50, ago(60)), point(6, "Shore power tariff", "fixture:shore-power", 55, ago(10)),
  ]);
  db.seed("research_assessments", [{ id: uuid(600), item_id: ITEM.research, is_current: true, technical_maturity_low: 8, technical_maturity_high: 9, entity_id: E("carrier:bio_methanol"), computed_at: `${ago(5)}T09:00:00Z` }]);
  db.seed("statutory_computations", [{ computation_id: uuid(700), entity_id: E("carrier:bio_methanol"), scenario_key: "default", obligation_id: "cl:obligation:00000000000000a3", formula_id: "fixture", formula_version: "1", statute_citation: "fixture", inputs: [], result: 100, result_unit: "EUR/tCO2e", computed_at: `${ago(5)}T09:00:00Z` }]);
  db.seed("derived_values", [{ value_id: uuid(800), entity_id: E("carrier:bio_methanol"), method_id: "fixture_abatement", method_version: "1", value: 95, unit: "EUR/tCO2e", currency: "EUR", derivation: "calculated", origin_class: "derived", lifecycle: "emerging", admissibility: "analysis_ok", base_confidence: 0.6, asserted_at: `${ago(5)}T09:00:00Z`, inputs: [], computed_by: "fixture" }]);
}

/** The fixture with the planted data. The cadence is on, so the fixture transport serves the cited pages. */
export function patternFixture(): Fixture {
  const f = fixture();
  plant(f);
  return f;
}
export const propagate = (f: Fixture) => runTurn({ stage: "propagate", mode: "apply", input: {} }, { d: f.d, env: {}, now: () => NOW });
export const connect = (f: Fixture) => runTurn({ stage: "connect", mode: "apply" }, { d: f.d, env: {}, now: () => NOW });
export const patterns = (f: Fixture): Row[] => f.db.rows("derived_values").filter((v) => String(v.method_id).startsWith("pattern_"));
export const countsOf = (f: Fixture, family: string): Record<string, number> => (f.db.rows("harness_runs").filter((x) => x.family === family).at(-1)?.outputs as { counts: Record<string, number> }).counts;
