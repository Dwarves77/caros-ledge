// A stand-in for the live ontology (the entities, entity_relations and entity_refs the database holds): the test worlds seed these rows into their fake tables, and the helpers answer by the fixture's keys. The engine itself holds no list of entities
// (ADR-053, NO-ENTITY-LISTS-1); a test that needs a fuel, a mode or a node reads it from here, the way production reads it from the database.
import { uuidOf } from "@/core/coupling";

import fixture from "./data/ontology-fixture.ts";

export interface FixtureEntity {
  key: string;
  class: string;
  name: string;
  kind: string;
  role: string;
  entityId: string;
  modes: string[];
  unit?: string | null;
}
export const FIXTURE_ENTITIES: readonly FixtureEntity[] = fixture.entities as unknown as FixtureEntity[];
// the curated modes of an entity (fixture data) are stated as the fuel_for_mode relations the live graph carries, since the engine derives an entity's modes from its relations to mode entities
const MODE_KEY = (m: string): string => `mode:${m}`;
const modeEdges = FIXTURE_ENTITIES.filter((e) => e.class === "carrier" && e.modes.length).flatMap((e) => e.modes.map((m) => ({ parent: e.key, child: MODE_KEY(m), relation: "fuel_for_mode" })));
export const FIXTURE_RELATIONS: readonly { parent: string; child: string; relation: string }[] = [...fixture.relations, ...modeEdges.filter((m) => !fixture.relations.some((r) => r.parent === m.parent && r.child === m.child && r.relation === m.relation))];
export const couplingByKey = (key: string): FixtureEntity | undefined => FIXTURE_ENTITIES.find((e) => e.key === key);
/** The entity id of a fixture key. */
export const E = (key: string): string => (couplingByKey(key) as FixtureEntity).entityId;
export const roleOf = (entityId: string): string => FIXTURE_ENTITIES.find((e) => e.entityId === entityId)?.role ?? "cites_entity";
/** The rows a world seeds: entities, relations and one mode ref per mode entity (what the live refs hold: the closed mode token a typed column was filed from). */
export const fixtureRows = (): { entities: Record<string, unknown>[]; relations: Record<string, unknown>[]; refs: Record<string, unknown>[] } => ({
  entities: FIXTURE_ENTITIES.map((c) => ({ entity_id: c.entityId, kind: c.kind, canonical_name: c.name, display_name: c.name, status: "active", merged_into: null })),
  relations: FIXTURE_RELATIONS.map((r) => ({ parent_entity_id: E(r.parent), child_entity_id: E(r.child), relation: r.relation, asserted_by: "coupling/seed", source_id: null, provenance: {}, method_version: null })),
  refs: [
    // what the live refs hold of a mode entity: the closed mode token a typed column was filed from
    ...FIXTURE_ENTITIES.filter((c) => c.class === "mode").map((c) => ({ ref_table: "fixture_mode", ref_id: uuidOf(`fixture-${c.key}`), entity_id: c.entityId, role: "cites_mode", asserted_by: "fixture", basis: { table: "obligation_objects", pk: `fixture-${c.key}`, column: "mode", value: c.modes[0] }, method_version: "fixture@1" })),
    // and one ref per other entity under its class role, so the class the live refs give it (hub, carrier, node ...) is the one the fixture states
    ...FIXTURE_ENTITIES.filter((c) => c.class !== "mode").map((c) => ({ ref_table: "fixture_class", ref_id: uuidOf(`fixture-${c.key}`), entity_id: c.entityId, role: c.role, asserted_by: "fixture", basis: { class: c.class }, method_version: "fixture@1" })),
  ],
});

/** A Reader's filing of a row under an entity (what the digest apply writes): the test worlds plant these where the old word matching used to find the entity. */
export const readerRef = (table: string, id: string, key: string, quote: string): Record<string, unknown> => ({ ref_table: table, ref_id: id, entity_id: E(key), role: roleOf(E(key)), asserted_by: "reader", basis: { quote }, method_version: "reader@1.1.0" });
