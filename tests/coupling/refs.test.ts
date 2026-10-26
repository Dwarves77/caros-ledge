// CONNECT-2 C2: entity-ref mining over the full corpus. Claims, typed rows and scenario tags are mined into entity_refs, each ref with the basis it came from and the version of the rule (INV-CN2-8: none without a basis; the database refuses one, the migration's self-check attacks it);
// a second run writes none; a dry run counts what it would write; the claims that name no entity are counted by kind.
import assert from "node:assert/strict";
import { test } from "node:test";

import { mineRefs, tagRefs, uuidOf } from "@/core/coupling";

import { NOW } from "../integration/world.ts";

import { claim, E, ITEM, OBLIGATION, patternFixture, propagate } from "./_world.ts";

const refsOf = (f: ReturnType<typeof patternFixture>) => f.db.rows("entity_refs").filter((r) => r.asserted_by === "coupling/refs");

test("C2a: a claim resolves to an entity only by a formal code it states: an instrument identifier or a UN/LOCODE, with the claim id and span as its basis; no word of the prose is matched", async () => {
  const f = patternFixture();
  f.db.seed("section_claim_provenance", [claim(ITEM.reg, "Regulation (EU) 2023/2405 raises the blending obligation.", "2026-10-01", "b1000000-0000-4000-8000-000000000031", 1)]);
  await propagate(f);
  const byId = refsOf(f).find((r) => r.entity_id === E("instrument:32023R2405") && r.ref_table === "section_claim_provenance");
  assert.equal((byId?.basis as { how: string }).how, "identifier", "an instrument named by its number resolves through the parse module's equality, not a substring");
  assert.equal(byId?.role, "cites_instrument");
  const ammonia = refsOf(f).filter((r) => r.entity_id === E("carrier:green_ammonia") && r.ref_table === "section_claim_provenance");
  assert.equal(ammonia.length, 0, "the six claims that say green ammonia in words are filed under nothing by the mining pass");
});

const DE = "cl:jurisdiction:dddddddddddddddd";
const RTM = "cl:node:eeeeeeeeeeeeeeee";
const HOSTORG = "cl:organisation:ffffffffffffffff";
const ETS = "cl:instrument:1111111111111111";

test("INV-JOIN-8: a country name in prose yields no ref; a UN/LOCODE and a CELEX identifier stated in prose yield the entity that holds them; a host and a title in prose yield none", async () => {
  const f = patternFixture();
  f.db.seed("entities", [
    { entity_id: DE, kind: "jurisdiction", canonical_name: "DE", display_name: null },
    { entity_id: RTM, kind: "node", canonical_name: "Rotterdam", display_name: null },
    { entity_id: HOSTORG, kind: "organisation", canonical_name: "eur-lex.europa.eu", display_name: null },
    { entity_id: ETS, kind: "instrument", canonical_name: "32003L0087", display_name: null },
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
  f.db.seed("entities", [{ entity_id: DE, kind: "jurisdiction", canonical_name: "DE", display_name: null }]);
  const queue = "b5000000-0000-4000-8000-000000000001";
  f.db.seed("grid_connection_queues", [{ queue_id: queue, jurisdiction_id: DE, dso_name: "Germany Netz", capacity_band_mw: null, queue_months_p50: null, as_of: "2026-05-29", obs_status: "L", origin_class: "official", derivation: "observed" }]);
  await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  const mine = refsOf(f).filter((r) => r.ref_table === "grid_connection_queues" && r.ref_id === queue && r.entity_id === DE);
  assert.deepEqual(mine.map((r) => [r.role, r.basis]), [["cites_jurisdiction", { table: "grid_connection_queues", pk: queue, column: "jurisdiction_id", value: DE }]]);
  assert.equal(refsOf(f).filter((r) => r.ref_id === queue).every((r) => (r.basis as { column: string | null }).column !== "dso_name"), true, "the operator's name in prose files nothing");
});

test("INV-JOIN-8: the refs the pass wrote by matching words (name, alias, acronym, a typed text label) are counted by basis kind and retired; the formal and typed refs stay; a dry run counts and retires nothing", async () => {
  const f = patternFixture();
  const old = (ref_table: string, ref_id: string, entity_id: string, basis: Record<string, unknown>) => ({ ref_table, ref_id, entity_id, role: "cites_jurisdiction", asserted_by: "coupling/refs", basis, method_version: "refs@1.0.0" });
  f.db.seed("entity_refs", [
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000001", DE, { how: "name", span: [0, 7] }),
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000002", DE, { how: "alias", span: [0, 3] }),
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000003", DE, { how: "acronym", span: [0, 3] }),
    old("market_series", "b6000000-0000-4000-8000-000000000004", DE, { table: "market_series", pk: "x", column: "label", value: "Germany", span: [0, 7] }),
    old("section_claim_provenance", "b6000000-0000-4000-8000-000000000005", DE, { how: "identifier", span: [0, 7] }),
    old("grid_connection_queues", "b6000000-0000-4000-8000-000000000006", DE, { table: "grid_connection_queues", pk: "y", column: "jurisdiction_id", value: DE }),
  ]);
  const dry = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: true });
  assert.deepEqual([dry.counts.refs_before_prose, dry.counts.refs_before_formal, dry.counts.refs_before_typed], [4, 1, 1], "by basis kind, before anything is retired");
  assert.equal(f.db.rows("entity_refs").filter((r) => r.entity_id === DE).length, 6, "a dry run retires nothing");
  const applied = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.equal(applied.counts.refs_prose_retired, 4);
  assert.deepEqual(f.db.rows("entity_refs").filter((r) => r.entity_id === DE).map((r) => r.ref_id).sort(), ["b6000000-0000-4000-8000-000000000005", "b6000000-0000-4000-8000-000000000006"]);
  assert.equal((await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false })).counts.refs_prose_existing, 0, "a second run finds nothing to retire");
});

test("C2b: a typed table's rows are mined through the column map: a coded value, a mode, a name in a label, the refs of the claim an event rests on; a text key is keyed by its uuid", async () => {
  const f = patternFixture();
  await propagate(f);
  const of = (table: string, entity: string) => refsOf(f).filter((r) => r.ref_table === table && r.entity_id === E(entity));
  const oem = of("oem_tech_roadmaps", "carrier:hefa_saf");
  assert.deepEqual(oem.map((r) => r.basis), [{ table: "oem_tech_roadmaps", pk: "a0000000-0000-4000-8000-000000000400", column: "tech_category", value: "saf_refinery" }]);
  const ob = of("obligation_objects", "mode:air");
  assert.equal(ob[0]?.ref_id, uuidOf(OBLIGATION.air));
  assert.equal((ob[0]?.basis as { pk: string }).pk, OBLIGATION.air, "the real key rides in the basis");
  assert.equal(of("obligation_objects", "instrument:32023R2405").length, 1, "the instrument entity the obligation names");
  assert.equal(of("market_series", "carrier:hvo").length, 2, "both points of the series filed under the entity by its typed entity_id column");
  assert.equal(of("item_forward_events", "carrier:hvo").length, 1, "the event takes the refs of the claim it rests on");
  assert.equal(of("statutory_computations", "carrier:bio_methanol").length, 1);
  assert.ok(of("research_assessments_current", "carrier:bio_methanol").length === 1);
});

test("C2c: the scenario tags of an item resolve to the couplings that list them, the tag as basis", () => {
  const known = new Set([E("node:saf_blending"), E("carrier:hefa_saf")]);
  const refs = tagRefs(ITEM.reg, ["SAF-blending", "no-such-tag"], known);
  assert.deepEqual(refs.map((r) => [r.entity_id, r.basis, r.role]).sort(), [[E("carrier:hefa_saf"), { tag: "SAF-blending" }, "cites_carrier"], [E("node:saf_blending"), { tag: "SAF-blending" }, "cites_node"]].sort());
  assert.deepEqual(tagRefs(ITEM.reg, ["SAF-blending"], new Set()), [], "a coupling that is not an entity gets no ref");
});

test("INV-CN2-8: every ref the mining writes carries a basis and the method version; a second run writes none; a dry run writes none and counts the new ones", async () => {
  const f = patternFixture();
  await propagate(f);
  const mined = refsOf(f);
  assert.ok(mined.length > 10);
  for (const r of mined) {
    assert.ok(r.basis && typeof r.basis === "object", `${String(r.ref_table)} ${String(r.entity_id)} has a basis`);
    assert.match(String(r.method_version), /^refs@/);
  }
  const again = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.equal(again.counts.refs_written, 0);
  assert.equal(again.counts.refs_new, 0);
  f.db.seed("section_claim_provenance", [claim(ITEM.reg, "Regulation (EU) 2023/2405 doubled the shore power connections.", "2026-10-02", "b1000000-0000-4000-8000-000000000032", 1)]);
  const before = f.db.rows("entity_refs").length;
  const dry = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: true });
  assert.equal(dry.counts.refs_new, 1);
  assert.equal(f.db.rows("entity_refs").length, before);
  assert.ok((dry.counts.claims_unresolved_fact ?? 0) >= 12, "the claims that state no formal code are counted by kind, never guessed");
});
