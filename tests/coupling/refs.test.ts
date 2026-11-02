// CONNECT-2 C2 under NO-ENTITY-LISTS-1: entity-ref mining over the full corpus. Claims (by formal code), typed rows and foreign keys are mined into entity_refs, each ref with the basis it came from and the version of the rule (INV-CN2-8: none without a basis; the database refuses one, the migration's self-check attacks it);
// a second run writes none; a dry run counts what it would write; the claims that name no entity are counted by kind.
import assert from "node:assert/strict";
import { test } from "node:test";

import { mineRefs, uuidOf } from "@/core/coupling";

import { NOW } from "../integration/world.ts";

import { claim, E, ITEM, OBLIGATION, patternFixture, connect } from "./_world.ts";

const refsOf = (f: ReturnType<typeof patternFixture>) => f.db.rows("entity_refs").filter((r) => r.asserted_by === "coupling/refs");

test("C2a: a claim resolves to an entity by a formal code it states (an instrument identifier, a UN/LOCODE), with the claim id and span as its basis; the item the claim belongs to is filed under the union of its claims' refs; a name in prose resolves nothing", async () => {
  const f = patternFixture();
  f.db.seed("section_claim_provenance", [claim(ITEM.reg, "Regulation (EU) 2023/2405 raises the blending obligation.", "2026-10-01", "b1000000-0000-4000-8000-000000000031", 1), claim(ITEM.reg, "Green ammonia offtake agreements were announced.", "2026-10-01", "b1000000-0000-4000-8000-000000000032", 1)]);
  await connect(f);
  const byId = refsOf(f).find((r) => r.entity_id === E("instrument:32023R2405") && r.ref_table === "section_claim_provenance");
  assert.equal((byId?.basis as { how: string }).how, "identifier", "an instrument named by its number resolves through the parse module's equality, not a substring");
  assert.equal(byId?.role, "cites_instrument");
  assert.equal(refsOf(f).filter((r) => r.entity_id === E("carrier:green_ammonia") && r.ref_table === "section_claim_provenance").length, 0, "a fuel named in prose is no mention: the Reader files it, the engine does not match words");
  const onItem = refsOf(f).filter((r) => r.ref_table === "intelligence_items" && r.ref_id === ITEM.reg && r.entity_id === E("instrument:32023R2405"));
  assert.deepEqual(onItem.map((r) => (r.basis as { how: string }).how), ["union_of_claims"]);
});

const DE = "cl:jurisdiction:dddddddddddddddd";
const RTM = "cl:node:eeeeeeeeeeeeeeee";
const HOSTORG = "cl:organisation:ffffffffffffffff";
const ETS = E("instrument:32003L0087");

test("INV-JOIN-8 (ADR-053): a country name in prose yields no ref; a UN/LOCODE and a CELEX identifier stated in prose yield the entity that holds them; a host, an organisation, a title and an acronym in prose yield none", async () => {
  const f = patternFixture();
  f.db.rows("entities").push(...[
    { entity_id: DE, kind: "jurisdiction", canonical_name: "DE", display_name: null },
    { entity_id: RTM, kind: "node", canonical_name: "Rotterdam", display_name: null },
    { entity_id: HOSTORG, kind: "organisation", canonical_name: "eur-lex.europa.eu", display_name: null },
  ]);
  f.db.seed("entity_identifiers", [{ entity_id: RTM, scheme: "UNLOCODE", value: "NLRTM" }, { entity_id: HOSTORG, scheme: "HOST", value: "eur-lex.europa.eu" }]);
  const ids = { country: "b4000000-0000-4000-8000-000000000001", code: "b4000000-0000-4000-8000-000000000002", celex: "b4000000-0000-4000-8000-000000000003", host: "b4000000-0000-4000-8000-000000000004" };
  f.db.seed("section_claim_provenance", [
    claim(ITEM.reg, "Germany and Done at Luxembourg were named in the report.", "2026-10-01", "b1000000-0000-4000-8000-000000000051", 1, "FACT", ids.country),
    claim(ITEM.reg, "The cargo was discharged at NLRTM on Tuesday.", "2026-10-01", "b1000000-0000-4000-8000-000000000052", 1, "FACT", ids.code),
    claim(ITEM.reg, "Directive 2003/87/EC (CELEX 32003L0087) sets the cap.", "2026-10-01", "b1000000-0000-4000-8000-000000000053", 1, "FACT", ids.celex),
    claim(ITEM.reg, "The text was published on eur-lex.europa.eu in 2023.", "2026-10-01", "b1000000-0000-4000-8000-000000000054", 1, "FACT", ids.host),
  ]);
  await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  const of = (claimId: string) => refsOf(f).filter((r) => r.ref_id === claimId).map((r) => [r.entity_id, (r.basis as { how: string }).how]);
  assert.deepEqual(of(ids.country), [], "a country name in prose is no mention");
  assert.deepEqual(of(ids.code), [[RTM, "code"]], "a UN/LOCODE is a formal code");
  assert.deepEqual(of(ids.host), [], "a publisher's host in prose is no mention: hosts stay on sources");
  assert.deepEqual(of(ids.celex), [[ETS, "identifier"]], "a CELEX number resolves to the instrument entity that holds it");
});

test("INV-JOIN-8: a typed jurisdiction column files a row under the jurisdiction entity, with the column and value as its basis", async () => {
  const f = patternFixture();
  f.db.rows("entities").push({ entity_id: DE, kind: "jurisdiction", canonical_name: "DE", display_name: null });
  const queue = "b5000000-0000-4000-8000-000000000001";
  f.db.seed("grid_connection_queues", [{ queue_id: queue, jurisdiction_id: DE, dso_name: "Germany Netz", capacity_band_mw: null, queue_months_p50: null, as_of: "2026-05-29", obs_status: "L", origin_class: "official", derivation: "observed" }]);
  await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  const mine = refsOf(f).filter((r) => r.ref_table === "grid_connection_queues" && r.ref_id === queue && r.entity_id === DE);
  assert.deepEqual(mine.map((r) => [r.role, r.basis]), [["cites_jurisdiction", { table: "grid_connection_queues", pk: queue, column: "jurisdiction_id", value: DE }]]);
  assert.equal(refsOf(f).filter((r) => r.ref_id === queue).every((r) => (r.basis as { column: string | null }).column !== "dso_name"), true, "the operator's name in prose files nothing");
});

test("NE1: the mining retires nothing: a ref is never deleted because its entity is absent from a file or its basis looks like prose; a dry run counts the refs it keeps", async () => {
  const f = patternFixture();
  const old = (ref_table: string, ref_id: string, entity_id: string, basis: Record<string, unknown>) => ({ ref_table, ref_id, entity_id, role: "cites_jurisdiction", asserted_by: "coupling/refs", basis, method_version: "refs@1.0.0" });
  f.db.seed("entity_refs", [
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000001", DE, { how: "name", span: [0, 7] }),
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000002", DE, { how: "alias", span: [0, 3] }),
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000003", DE, { how: "acronym", span: [0, 3] }),
    { ...old("section_claim_provenance", "b6000000-0000-4000-8000-000000000007", E("carrier:green_ammonia"), { how: "name", span: [0, 13] }), role: "cites_carrier" },
    old("market_series", "b6000000-0000-4000-8000-000000000004", DE, { table: "market_series", pk: "x", column: "label", value: "Germany", span: [0, 7] }),
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000005", DE, { how: "identifier", span: [0, 7] }),
  ]);
  const before = f.db.rows("entity_refs").length;
  const dry = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: true });
  assert.deepEqual([dry.counts.refs_kept, dry.counts.refs_retired], [before, 0]);
  const applied = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.equal(applied.counts.refs_retired, 0);
  assert.equal(f.db.rows("entity_refs").filter((r) => ["1", "2", "3", "4", "5", "7"].some((n) => r.ref_id === `b6000000-0000-4000-8000-00000000000${n}`)).length, 6, "every one of the six old refs stays, whatever its basis");
});

test("NE1: a ref copied through a foreign key carries where it came from: an obligation and a forward event are filed under their item's refs (inherited_from_item), and an item under the union of its claims' refs", async () => {
  const f = patternFixture();
  f.db.seed("section_claim_provenance", [claim(ITEM.reg, "Regulation (EU) 2023/2405 raises the blending obligation.", "2026-10-01", "b1000000-0000-4000-8000-000000000031", 1)]);
  await connect(f);
  const inherited = (table: string, id: string) => refsOf(f).filter((r) => r.ref_table === table && r.ref_id === id && "inherited_from_item" in (r.basis as object));
  const ocean = inherited("obligation_objects", uuidOf(OBLIGATION.ocean));
  assert.ok(ocean.some((r) => r.entity_id === E("instrument:32023R2405")), "the ocean obligation names no instrument itself and takes its item's");
  assert.equal((ocean[0]?.basis as { inherited_from_item: string }).inherited_from_item, ITEM.reg);
  const event = inherited("item_forward_events", "a0000000-0000-4000-8000-000000000500");
  assert.ok(event.some((r) => r.entity_id === E("instrument:32023R2405")), "the forward event takes its item's refs, though its source claim is not the one that named the instrument");
  assert.ok(refsOf(f).filter((r) => r.ref_table === "obligation_objects" && r.entity_id === E("instrument:32023R2405") && !("inherited_from_item" in (r.basis as object))).length >= 1, "a typed ref (the obligation's own instrument column) is distinguishable from an inherited one");
});

test("C2b: a typed table's rows are mined through the column map: an entity id column, a closed mode token, the refs of the claim an event rests on; a text key is keyed by its uuid; no word is mapped to an entity", async () => {
  const f = patternFixture();
  await connect(f);
  const of = (table: string, entity: string) => refsOf(f).filter((r) => r.ref_table === table && r.entity_id === E(entity));
  assert.deepEqual(of("oem_tech_roadmaps", "carrier:hefa_saf"), [], "a technology category is a word: the mining files nothing from it (the Reader's ref stands)");
  const ob = of("obligation_objects", "mode:air");
  assert.equal(ob[0]?.ref_id, uuidOf(OBLIGATION.air));
  assert.equal((ob[0]?.basis as { pk: string }).pk, OBLIGATION.air, "the real key rides in the basis");
  assert.equal((ob[0]?.basis as { value: unknown }).value, "air", "ENTITY-MINT-1: a mode ref's basis carries the one token the entity was filed from, not the row's whole mode array");
  assert.equal(of("obligation_objects", "instrument:32023R2405").length, 1, "the instrument entity the obligation names");
  assert.equal(of("market_series", "carrier:hvo").length, 2, "both points of the series filed under the entity by its typed entity_id column");
  assert.equal(of("item_forward_events", "carrier:hvo").length, 1, "the event takes the refs of the claim it rests on");
  assert.equal(of("statutory_computations", "carrier:bio_methanol").length, 1);
  assert.ok(of("research_assessments_current", "carrier:bio_methanol").length === 1);
});

test("INV-CN2-8: every ref the mining writes carries a basis and the method version; a second run writes none; a dry run writes none and counts the new ones", async () => {
  const f = patternFixture();
  await connect(f);
  const mined = refsOf(f);
  assert.ok(mined.length > 10);
  for (const r of mined) {
    assert.ok(r.basis && typeof r.basis === "object", `${String(r.ref_table)} ${String(r.entity_id)} has a basis`);
    assert.match(String(r.method_version), /^refs@/);
  }
  const again = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.equal(again.counts.refs_written, 0);
  assert.equal(again.counts.refs_new, 0);
  f.db.seed("section_claim_provenance", [claim(ITEM.reg, "Shore power connections doubled.", "2026-10-02", "b1000000-0000-4000-8000-000000000032", 1)]);
  const before = f.db.rows("entity_refs").length;
  const dry = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: true });
  assert.equal(dry.counts.refs_new, 0, "a claim that states no code files nothing");
  assert.equal(f.db.rows("entity_refs").length, before);
  assert.ok((dry.counts.claims_unresolved_fact ?? 0) >= 12, "the background claims name no code: counted by kind, never guessed");
});

test("NE1: a market series is filed only under the entity its typed entity_id column holds; a series key is a word and maps to nothing", async () => {
  const f = patternFixture();
  const row = (n: number, key: string, entity: string | null) => ({ id: `b7000000-0000-4000-8000-00000000000${n}`, series_key: key, label: "a label that names nothing", entity_id: entity, value_numeric: 1, unit: "EUR/t", currency: "EUR", derivation: "observed", origin_class: "official", source_key: "fixture", source_ref: "fixture", as_at_date: "2026-10-01" });
  f.db.seed("market_series", [row(1, "eu-oil-bulletin:automotive-diesel", null), row(2, "ecb-fx:eur-usd", E("carrier:fossil_diesel"))]);
  await connect(f);
  const filed = (n: number) => refsOf(f).filter((r) => r.ref_table === "market_series" && r.ref_id === `b7000000-0000-4000-8000-00000000000${n}`).map((r) => [r.entity_id, r.role, (r.basis as { column: string }).column]);
  assert.deepEqual(filed(1), [], "a formal series code is not mapped to a fuel by the engine");
  assert.deepEqual(filed(2), [[E("carrier:fossil_diesel"), "cites_carrier", "entity_id"]]);
});
