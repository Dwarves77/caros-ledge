// NO-ENTITY-LISTS-1 (ADR-053): the ontology is the database. The class of an entity is the class its refs are filed under most, its modes are the tokens of the mode entities its relations reach, a closed mode token resolves to the entity the live refs file it under; nothing is typed in code.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ontologyOf } from "@/core/coupling";

const [AIR, OCEAN, HVO, SAF, WIN, DE] = ["cl:asset:1", "cl:asset:2", "cl:material:3", "cl:material:4", "cl:method:5", "cl:jurisdiction:6"];
const ref = (entity_id: string, role: string, basis: { column?: string; value?: string } | null = null) => ({ entity_id, role, basis });
const onto = ontologyOf({
  entities: [{ entity_id: AIR, kind: "asset" }, { entity_id: OCEAN, kind: "asset" }, { entity_id: HVO, kind: "material" }, { entity_id: SAF, kind: "material" }, { entity_id: WIN, kind: "method", canonical_name: "0-6m" }, { entity_id: DE, kind: "jurisdiction" }],
  refs: [ref(AIR, "cites_mode", { column: "mode", value: "air" }), ref(OCEAN, "cites_mode", { column: "mode", value: "sea" }), ref(HVO, "cites_carrier"), ref(HVO, "cites_instrument"), ref(HVO, "cites_carrier"), ref(DE, "cites_jurisdiction")],
  relations: [{ parent_entity_id: SAF, child_entity_id: AIR }, { parent_entity_id: HVO, child_entity_id: OCEAN }, { parent_entity_id: HVO, child_entity_id: AIR }],
});

test("the class of an entity is read from the refs it is filed under (a specific class beats an instrument or jurisdiction role), else its kind, else the shape of its name", () => {
  assert.deepEqual([AIR, HVO, SAF, DE, WIN].map(onto.classOf), ["mode", "carrier", "material", "jurisdiction", "window"]);
  assert.equal(onto.classOf("cl:unknown:9"), "unknown", "an entity nothing is known of is classed by the kind its id states");
});

test("the modes of an entity: a mode entity carries the closed tokens its typed-column refs were filed from (normalised); any other entity carries those of the mode entities one relation away; none otherwise", () => {
  assert.deepEqual(onto.modesOf(AIR), ["air"]);
  assert.deepEqual(onto.modesOf(OCEAN), ["ocean"], "sea is an input alias of the ocean mode");
  assert.deepEqual(onto.modesOf(HVO), ["air", "ocean"]);
  assert.deepEqual(onto.modesOf(SAF), ["air"]);
  assert.deepEqual(onto.modesOf(DE), []);
});

test("a closed mode token resolves to the entity the live refs file it under; the ref role of an entity follows its class; a token no row has been filed under resolves to none", () => {
  assert.equal(onto.modeEntity("air"), AIR);
  assert.equal(onto.modeEntity("sea"), OCEAN);
  assert.equal(onto.modeEntity("rail"), undefined);
  assert.deepEqual([onto.roleOf(HVO), onto.roleOf(AIR), onto.roleOf(DE)], ["cites_carrier", "cites_mode", "cites_jurisdiction"]);
});
