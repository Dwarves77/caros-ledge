// The candidate_entities menu from the LIVE graph (TRIANGLE-TRACE Q3, ADR-053, GRAPH-GROW-1: no static entity list): the item's own instrument first, then the entities its claims, events and obligations are typed-linked to, then the graph neighbours
// (one hop in entity_relations, a shared formal code), then the entities the item's domain files most, then region and publisher lines; modes, hubs and windows stay out; the cap holds with the truncation stated; the ranking reads typed refs only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MENU } from "@/core/digest/kinds";
import { entityId } from "@/core/entities/id";
import { drainExporters } from "@/features/batches";
import { candidateMenu } from "@/features/batches/kinds/item-briefs/candidates";
import type { BatchExport } from "@/features/batches";

import { MemDb } from "../_support/memdb.ts";

import { emissionWorld, HVO, OCEAN, SELF, UCO } from "./emission-world.ts";

const ent = (kind: string, name: string) => ({ entity_id: entityId(kind as never, name), kind, canonical_name: name, status: "active" });
const id = (kind: string, name: string): string => entityId(kind as never, name);
const EU = id("jurisdiction", "EU");
const PUB = id("organisation", "eur-lex.europa.eu");
const OTHER_ITEM = "b0000000-0000-4000-8000-000000000002";
const ref = (table: string, refId: string, entity: string) => ({ ref_table: table, ref_id: refId, entity_id: entity, role: "cites_entity", asserted_by: "t", basis: { q: 1 }, method_version: "reader@1.1.0" });

function graph(extra: { linked?: number } = {}) {
  const db = new MemDb();
  const lnk = Array.from({ length: extra.linked ?? 0 }, (_, i) => ent("organisation", `linked-${i}.example`));
  db.seed("entities", [
    { entity_id: SELF, kind: "instrument", canonical_name: "32023R9999", status: "active" },
    ent("jurisdiction", "EU"), ent("organisation", "eur-lex.europa.eu"), ent("material", "Used cooking oil"), ent("material", "HVO"),
    ent("organisation", "Neighbour via relation"), ent("organisation", "Neighbour via code"), ent("technology", "Domain technology"), ent("organisation", "Retired one"),
    ...lnk,
  ]);
  db.rows("entities").find((e) => e.canonical_name === "Retired one")!.status = "retired";
  db.seed("entity_identifiers", [
    { entity_id: SELF, scheme: "CELEX", value: "32023R9999", asserted_by: "t" },
    { entity_id: id("organisation", "Neighbour via code"), scheme: "CELEX", value: "32023R9999", asserted_by: "t" },
  ]);
  db.seed("entity_aliases", ["a", "b", "c", "d", "e", "f"].map((a) => ({ entity_id: id("material", "HVO"), alias: `alias ${a}`, alias_kind: "name", asserted_by: "t" })));
  db.seed("entity_relations", [{ parent_entity_id: id("material", "HVO"), child_entity_id: id("organisation", "Neighbour via relation"), relation: "feedstock_of", asserted_by: "t", basis: { q: 1 }, method_version: "reader@1.1.0" }]);
  db.seed("intelligence_items", [{ id: OTHER_ITEM, domain: 3, is_archived: false, added_date: "2026-01-01" }]);
  db.seed("entity_refs", [ref("intelligence_items", OTHER_ITEM, id("technology", "Domain technology")), ref("intelligence_items", OTHER_ITEM, id("organisation", "Retired one"))]);
  return db;
}
const linked = (n: number) => new Map(Array.from({ length: n }, (_, i) => [id("organisation", `linked-${i}.example`), n - i] as const));

test("rank: own instrument, linked by weight, then relation and shared-code neighbours, then the domain's entities, then region and publisher; nothing static, nothing retired; aliases come with the formal codes, at most four; the line format", async () => {
  const db = graph({ linked: 3 });
  const hvo = id("material", "HVO");
  const m = await candidateMenu(db.client, { self: SELF, weights: new Map([...linked(3), [hvo, 9]]), region: [EU], publisher: PUB, domain: 3, itemId: "a0000000-0000-4000-8000-000000000001" });
  assert.equal(m.ids[0], SELF);
  assert.deepEqual(m.ids.slice(1, 5), [hvo, ...linked(3).keys()], "linked by weight, heaviest first");
  assert.deepEqual(m.ids.slice(5, 7).sort(), [id("organisation", "Neighbour via code"), id("organisation", "Neighbour via relation")].sort(), "a one-hop relation and a shared formal code are neighbours");
  assert.equal(m.ids[7], id("technology", "Domain technology"), "the domain's entity, filed by another item of the domain");
  assert.deepEqual(m.ids.slice(-2), [EU, PUB]);
  assert.ok(!m.ids.includes(id("organisation", "Retired one")), "a retired entity is never offered");
  assert.ok(!m.ids.includes(id("material", "Used cooking oil")), "an entity nothing in the graph links to is not on the menu (no static list)");
  const line = m.lines.find((l) => l.startsWith(hvo)) as string;
  assert.equal(line.split(" | ").length, 5);
  assert.equal(line.split(" | ")[3]?.split("; ").length, 4, "aliases up to four");
  assert.match(m.lines.find((l) => l.startsWith(SELF)) as string, /CELEX:32023R9999/, "the alias column carries the formal codes");
  assert.equal(m.truncated, 0);
});

test("the neighbourhood reads the live graph: relations in both directions, shared codes, the domain's most-filed entities, never the item's own", async () => {
  const db = graph();
  const hvo = id("material", "HVO");
  const menu = await candidateMenu(db.client, { self: SELF, weights: new Map([[hvo, 1]]), domain: 3 });
  assert.ok(menu.ids.includes(id("organisation", "Neighbour via relation")), "the child end of a relation the linked entity is the parent of");
  assert.ok(menu.ids.includes(id("organisation", "Neighbour via code")), "an entity sharing a formal code with the item's instrument");
  assert.ok(menu.ids.includes(id("technology", "Domain technology")), "an entity the domain files");
  const own = await candidateMenu(db.client, { self: SELF, weights: new Map(), domain: 3, itemId: OTHER_ITEM });
  assert.ok(!own.ids.includes(id("technology", "Domain technology")), "an item's own refs are not its domain neighbours");
});

test("cap: over the cap the lowest-ranked linked entities drop and the block states the count, never silent; the own instrument and the region lines always stay", async () => {
  const db = graph({ linked: 60 });
  const m = await candidateMenu(db.client, { self: SELF, weights: linked(60), region: [EU] });
  assert.ok(m.ids.length <= MENU.cap, String(m.ids.length));
  assert.equal(m.ids.length, 1 + MENU.maxLinked + 1 + 1, "own instrument + the linked budget + the one shared-code neighbour + region");
  assert.equal(m.truncated, 60 - MENU.maxLinked);
  assert.equal(m.ids[0], SELF);
  assert.ok(m.ids.includes(id("organisation", "linked-0.example")) && !m.ids.includes(id("organisation", "linked-59.example")), "the heaviest stay, the lightest go");
  assert.ok(m.ids.includes(EU));
});

test("the item-briefs bundle carries the live menu, with the typed links the item's own claims, events and obligations are filed under, and the capture id of every pool entry", async () => {
  const w = emissionWorld();
  const claim = "c1000000-0000-4000-8000-0000000000aa";
  w.db.seed("section_claim_provenance", [{ id: claim, intelligence_item_id: ITEM_ID, claim_kind: "FACT", claim_text: "t", source_span: "s", source_id: null }]);
  w.db.seed("entity_refs", [{ ref_table: "section_claim_provenance", ref_id: claim, entity_id: HVO, role: "cites_carrier", asserted_by: "coupling/refs", basis: { claim_id: claim }, method_version: "refs@2.0.0" }, { ref_table: "section_claim_provenance", ref_id: claim, entity_id: UCO, role: "cites_feedstock", asserted_by: "coupling/refs", basis: null, method_version: null }]);
  const out = (await drainExporters(w.deps)["item-briefs"]!({ limit: 5, mode: "pending" })) as BatchExport;
  assert.equal(out.ok, true, out.error);
  const item = out.items[0] as { candidate_entities: { entities: string[]; truncated: number }; pool: { capture_id: string; text: string }[] };
  assert.equal(item.candidate_entities.truncated, 0);
  assert.equal(item.candidate_entities.entities[0]?.split(" | ")[0], SELF, "the item's own instrument leads");
  assert.match(item.candidate_entities.entities.find((l) => l.startsWith(HVO)) as string, /links: 1$/);
  assert.match(item.candidate_entities.entities.find((l) => l.startsWith(UCO)) as string, /links: 0$/, "a ref with no method version is not a typed link (offered here only as a shared-code neighbour)");
  assert.ok(!item.candidate_entities.entities.some((l) => l.startsWith(OCEAN)), "a mode token is never a menu line");
  assert.equal(item.pool[0]?.capture_id, w.cap);
});
const ITEM_ID = "a0000000-0000-4000-8000-000000000001";
