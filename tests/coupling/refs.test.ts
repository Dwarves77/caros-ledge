// CONNECT-2 C2: entity-ref mining over the full corpus. Claims, typed rows and scenario tags are mined into entity_refs, each ref with the basis it came from and the version of the rule (INV-CN2-8: none without a basis; the database refuses one, the migration's self-check attacks it);
// a second run writes none; a dry run counts what it would write; the claims that name no entity are counted by kind.
import assert from "node:assert/strict";
import { test } from "node:test";

import { mineRefs, tagRefs, uuidOf } from "@/core/coupling";

import { NOW } from "../integration/world.ts";

import { claim, E, ITEM, OBLIGATION, patternFixture, propagate } from "./_world.ts";

const refsOf = (f: ReturnType<typeof patternFixture>) => f.db.rows("entity_refs").filter((r) => r.asserted_by === "coupling/refs");

test("C2a: a claim resolves to the entity it names, by alias and by instrument identifier, with the claim id and span as its basis", async () => {
  const f = patternFixture();
  f.db.seed("section_claim_provenance", [claim(ITEM.reg, "Regulation (EU) 2023/2405 raises the blending obligation.", "2026-10-01", "b1000000-0000-4000-8000-000000000031", 1)]);
  await propagate(f);
  const ammonia = refsOf(f).filter((r) => r.entity_id === E("carrier:green_ammonia") && r.ref_table === "section_claim_provenance");
  assert.equal(ammonia.length, 6, "the six claims that name green ammonia");
  assert.deepEqual(ammonia.map((r) => r.role), Array(6).fill("cites_carrier"));
  const first = ammonia[0]?.basis as { claim_id: string; span: number[]; claim_kind: string; how: string };
  assert.deepEqual([first.span, first.claim_kind, first.how], [[0, 13], "FACT", "alias"]);
  assert.equal(first.claim_id, ammonia[0]?.ref_id);
  const byId = refsOf(f).find((r) => r.entity_id === E("instrument:32023R2405") && r.ref_table === "section_claim_provenance");
  assert.equal((byId?.basis as { how: string }).how, "identifier", "an instrument named by its number resolves through the parse module's equality, not a substring");
  assert.equal(byId?.role, "cites_instrument");
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
  assert.equal(of("market_series", "carrier:hvo").length, 2, "both points of the series named in its label");
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
  assert.ok(mined.length > 20);
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
  assert.equal(dry.counts.refs_new, 1);
  assert.equal(f.db.rows("entity_refs").length, before);
  assert.equal(dry.counts.claims_unresolved_fact, 12, "the twelve background claims name nothing: counted by kind, never guessed");
});
