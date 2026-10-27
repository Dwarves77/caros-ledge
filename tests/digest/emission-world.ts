// The reader-emission test world (DIGEST-1 PR B): one record item whose pool carries the sentences the typed blocks quote, the entities the candidate menu lists, and a full authored entry that exercises every block. The quotes are in the capture; a test breaks one value to attack it.
import { locateSpan } from "@/core/contracts/verbatim";
import { entityId } from "@/core/entities/id";
import type { BatchDeps } from "@/features/batches";

import { batchWorld, goodBody, claims, ITEM, metadata, OFFICIAL_TEXT, OFFICIAL_URL, passingReview, poolHashOf, SPAN_FORCE, SPAN_PENALTY } from "../batches/world.ts";
import { OTHER_TEXT, OTHER_URL } from "../intake/fixtures.ts";
import { couplingByKey, fixtureRows } from "../_support/ontology.ts";

export const MW = "Each Member State shall make available at least 50 MW of charging capacity within 24 months of the date of entry into force.";
export const FEED = "Hydrotreated vegetable oil is produced from used cooking oil, which is its main feedstock.";
export const ORG = "Maersk Line A/S operates the weekly service named in the annex.";
export const DONE = "Done at Strasbourg, 13 September 2023.";
export const EMIT_TEXT = `${OFFICIAL_TEXT}\nArticle 5. ${MW}\nArticle 6. ${FEED}\nArticle 7. ${ORG}\nArticle 8. Cargo is discharged at the port of Rotterdam NLRTM.\n${DONE}`;
export const SELF = entityId("instrument", "32023R9999");
export const UCO = couplingByKey("feed:uco")?.entityId as string;
export const HVO = couplingByKey("carrier:hvo")?.entityId as string;
export const OCEAN = couplingByKey("mode:ocean")?.entityId as string;

export function emissionWorld() {
  const w = batchWorld({ pool: [{ url: OFFICIAL_URL, text: EMIT_TEXT }, { url: OTHER_URL, text: OTHER_TEXT }] });
  const item = w.db.rows("intelligence_items")[0] as Record<string, unknown>;
  Object.assign(item, { provenance_status: "verified", instrument_entity_id: SELF });
  const cap = (w.db.rows("agent_run_searches").find((r) => r.result_url === OFFICIAL_URL) as { id: string }).id;
  const ent = (entity_id: string, kind: string, canonical_name: string) => ({ entity_id, kind, canonical_name, status: "active" });
  w.db.seed("entities", [ent(SELF, "instrument", "32023R9999"), ent(UCO, "material", "Used cooking oil"), ent(HVO, "material", "HVO"), ent(OCEAN, "asset", "Ocean freight"), ent(entityId("jurisdiction", "EU"), "jurisdiction", "EU"), ent(entityId("organisation", "eur-lex.europa.eu"), "organisation", "eur-lex.europa.eu")]);
  // the closed mode token the live refs file under the ocean asset (the ontology reads it from there)
  w.db.seed("entity_refs", fixtureRows().refs.filter((r) => r.entity_id === OCEAN));
  w.db.seed("entity_identifiers", [{ entity_id: SELF, scheme: "CELEX", value: "32023R9999", asserted_by: "t" }]);
  w.db.seed("entity_aliases", [{ entity_id: HVO, alias: "hydrotreated vegetable oil", alias_kind: "name", asserted_by: "t" }]);
  const deps: BatchDeps = { ...w.deps, locate: locateSpan };
  return { ...w, deps, cap, item };
}
export type EmissionWorld = ReturnType<typeof emissionWorld>;

/** One authored entry with every typed block, each value quoted from the pool. Sentences are quoted with their whitespace changed, as a reader copying a structured capture would. */
export function emissionEntry(w: EmissionWorld, over: Record<string, unknown> = {}): Record<string, unknown> {
  const q = (text: string) => ({ capture_id: w.cap, text });
  const f = (value: unknown, text: string) => ({ value, quote: q(text) });
  const entry: Record<string, unknown> = {
    item_id: ITEM, source_pool_hash: poolHashOf(w.db), body: goodBody(), metadata: metadata(), claims: claims(),
    entity_ids: [{ entity_id: SELF, quote: q("Regulation (EU) 2023/9999") }, { entity_id: HVO, quote: q("Hydrotreated\nvegetable oil") }, { entity_id: "CELEX:32023R9999", quote: q("Regulation (EU) 2023/9999") }],
    obligation_fields: [
      { pinpoint: "Article 3", provision: q(SPAN_PENALTY), entity_ids: [HVO], fields: { statutory_maximum: f("EUR 50 000", "A penalty of up to EUR 50 000"), sanction_class: f("monetary_capped", "A penalty of up to EUR 50 000"), duty_holder_class: f(["operator"], "an operator that fails to report"), binding_position: f("direct_duty", SPAN_PENALTY), applicability_trigger: f({ attribute: "instrument", value: "2023/9999" }, "This Regulation applies to operators"), mode: f(["ocean"], "operators of container vessels") } },
      { pinpoint: "Article 5", provision: q(MW), fields: { mandated_quantity: f({ value: 50, unit: "MW" }, "at least 50 MW of charging capacity"), due_date: f("2027-01-01", "1 January 2027"), duty_holder_class: f(["member_state"], "Each Member State shall"), binding_position: f("direct_duty", MW), applicability_trigger: f({ attribute: "instrument", value: "2023/9999" }, "Each Member State shall make available") } },
    ],
    connections: [{ from_entity_id: UCO, to_entity_id: HVO, relation: "feedstock_of", reason_token: "named_feedstock", quote: q(FEED) }],
    events: [{ event_kind: "entry_into_force", event_date: "2027-01-01", quote: q(SPAN_FORCE), mode: "ocean", entity_ids: [HVO] }],
    document_date: { date: "2023-09-13", quote: q(DONE) },
    new_entity_candidates: [{ proposed_kind: "organisation", canonical_name: "Maersk Line A/S", quote: q(ORG) }],
    ...over,
  };
  return { ...entry, review: passingReview(entry) };
}
