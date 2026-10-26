// The candidate_entities menu (TRIANGLE-TRACE Q3, ADR-053): the item's own instrument first, then linked entities by typed-link weight, then the rest of the closed ontology in kind order, then region and publisher lines; modes, hubs and windows
// stay out; the cap holds with the truncation stated; the ranking reads typed refs only. The bundle of an item carries it, and so do the pool's capture ids the reader cites.
import assert from "node:assert/strict";
import { test } from "node:test";

import { COUPLINGS, couplingByKey } from "@/core/coupling";
import { MENU } from "@/core/digest/kinds";
import { entityId } from "@/core/entities/id";
import { drainExporters } from "@/features/batches";
import { candidateMenu } from "@/features/batches/kinds/item-briefs/candidates";
import type { BatchExport } from "@/features/batches";

import { MemDb } from "../_support/memdb.ts";

import { emissionWorld, HVO, OCEAN, SELF, UCO } from "./emission-world.ts";

const ONTOLOGY = COUPLINGS.filter((c) => c.named);
const HUB = couplingByKey("hub:seaport")?.entityId as string;
function seeded(extra: { linked?: number } = {}) {
  const db = new MemDb();
  db.seed("entities", [
    ...COUPLINGS.map((c) => ({ entity_id: c.entityId, kind: c.kind, canonical_name: c.name, status: "active" })),
    { entity_id: SELF, kind: "instrument", canonical_name: "32023R9999", status: "active" },
    { entity_id: entityId("jurisdiction", "EU"), kind: "jurisdiction", canonical_name: "EU", status: "active" },
    { entity_id: entityId("organisation", "eur-lex.europa.eu"), kind: "organisation", canonical_name: "eur-lex.europa.eu", status: "active" },
    ...Array.from({ length: extra.linked ?? 0 }, (_, i) => ({ entity_id: entityId("organisation", `linked-${i}.example`), kind: "organisation", canonical_name: `Linked ${i}`, status: "active" })),
  ]);
  db.seed("entity_aliases", ["a", "b", "c", "d", "e", "f"].map((a) => ({ entity_id: HVO, alias: `alias ${a}`, alias_kind: "name", asserted_by: "t" })));
  return db;
}
const linked = (n: number) => new Map(Array.from({ length: n }, (_, i) => [entityId("organisation", `linked-${i}.example`), n - i] as const));

test("rank: the item's own instrument first, linked entities by weight, the ontology in kind order, region and publisher last; modes, hubs and windows omitted; aliases at most four; the line format", async () => {
  const db = seeded({ linked: 3 });
  const m = await candidateMenu(db.client, { self: SELF, weights: new Map([...linked(3), [UCO, 9], [OCEAN, 8], [HUB, 7]]), region: [entityId("jurisdiction", "EU")], publisher: entityId("organisation", "eur-lex.europa.eu") });
  assert.equal(m.ids[0], SELF);
  assert.deepEqual(m.ids.slice(1, 5), [UCO, ...[...linked(3).keys()]], "linked by weight desc: the ontology entity carrying 9 first, then 3, 2, 1");
  const classOf = (id: string) => ONTOLOGY.find((c) => c.entityId === id)?.class;
  const onto = m.ids.filter((id) => classOf(id) !== undefined && id !== UCO);
  assert.deepEqual([...new Set(onto.map(classOf))], MENU.kindOrder.filter((k) => ONTOLOGY.some((c) => c.class === k)), "the rest of the ontology in the configured kind order");
  assert.deepEqual(m.ids.slice(-2), [entityId("jurisdiction", "EU"), entityId("organisation", "eur-lex.europa.eu")]);
  assert.ok(!m.ids.includes(OCEAN) && COUPLINGS.filter((c) => ["mode", "hub", "window"].includes(c.class)).every((c) => !m.ids.includes(c.entityId)), "closed tokens stay out of the menu even when linked");
  const line = m.lines.find((l) => l.startsWith(HVO)) as string;
  assert.deepEqual(line.split(" | ").length, 5);
  assert.equal(line.split(" | ")[3]?.split("; ").length, 4, "aliases up to four");
  assert.match(m.lines.find((l) => l.startsWith(UCO)) as string, /links: 9 ontology: true$/, "a linked ontology entity is listed once and flagged");
  assert.equal(m.truncated, 0);
});

test("cap: over the cap the lowest-ranked linked entities drop and the block states the count, never silent; the ontology and the own instrument always stay", async () => {
  const db = seeded({ linked: 60 });
  const m = await candidateMenu(db.client, { self: SELF, weights: linked(60), region: [entityId("jurisdiction", "EU")] });
  assert.ok(m.ids.length <= MENU.cap, String(m.ids.length));
  assert.equal(m.truncated, 60 - (m.ids.length - 1 - ONTOLOGY.length - 1), "the dropped count is stated");
  assert.ok(m.truncated > 0);
  assert.equal(m.ids[0], SELF);
  assert.ok(ONTOLOGY.every((c) => m.ids.includes(c.entityId)));
  assert.ok(m.ids.includes(entityId("organisation", "linked-0.example")) && !m.ids.includes(entityId("organisation", "linked-59.example")), "the heaviest stay, the lightest go");
});

test("the item-briefs bundle carries the menu, with the typed links the item's own claims, events and obligations are filed under, and the capture id of every pool entry", async () => {
  const w = emissionWorld();
  const claim = "c1000000-0000-4000-8000-0000000000aa";
  w.db.seed("section_claim_provenance", [{ id: claim, intelligence_item_id: ITEM_ID, claim_kind: "FACT", claim_text: "t", source_span: "s", source_id: null }]);
  w.db.seed("entity_refs", [{ ref_table: "section_claim_provenance", ref_id: claim, entity_id: HVO, role: "cites_carrier", asserted_by: "coupling/refs", basis: { claim_id: claim }, method_version: "refs@2.0.0" }, { ref_table: "section_claim_provenance", ref_id: claim, entity_id: UCO, role: "cites_feedstock", asserted_by: "x", basis: null, method_version: null }]);
  const out = (await drainExporters(w.deps)["item-briefs"]!({ limit: 5, mode: "pending" })) as BatchExport;
  assert.equal(out.ok, true, out.error);
  const item = out.items[0] as { candidate_entities: { entities: string[]; truncated: number }; pool: { capture_id: string; text: string }[] };
  assert.equal(item.candidate_entities.truncated, 0);
  assert.equal(item.candidate_entities.entities[0]?.split(" | ")[0], SELF, "the item's own instrument leads");
  assert.match(item.candidate_entities.entities.find((l) => l.startsWith(HVO)) as string, /links: 1 ontology: true/);
  assert.match(item.candidate_entities.entities.find((l) => l.startsWith(UCO)) as string, /links: 0$/, "a ref with no method version is not a typed link");
  assert.equal(item.pool[0]?.capture_id, w.cap);
});
const ITEM_ID = "a0000000-0000-4000-8000-000000000001";
