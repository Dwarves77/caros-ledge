// CONNECT-2 C1: the seeds pass writes every coupling of couplings.json, each grounded: its quote stands verbatim on a captured page the class table rates, and the row records that source. A quote no capture holds is refused and counted, never written ungrounded; a second run writes nothing;
// a dry run plans the same counts and writes nothing; the relations form no cycle (the table's own trigger would refuse one).
import assert from "node:assert/strict";
import { test } from "node:test";

import { COUPLING_RELATIONS, COUPLINGS, couplingByKey } from "@/core/coupling";
import { entityId } from "@/core/entities";
import { seedCouplings } from "@/core/coupling";

import { fixture, NOW } from "../integration/world.ts";

import { E, propagate } from "./_world.ts";

test("the propagate stage captures the cited pages and seeds every coupling, each entity and relation carrying the source it is taken from and the quote", async () => {
  const f = fixture();
  const r = await propagate(f);
  assert.equal(r.exit, 0);
  const counts = (f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outputs as { counts: Record<string, number> }).counts;
  assert.equal(counts.seed_refused, 0);
  assert.equal(counts.seed_entities_written, COUPLINGS.length, "every coupling is an entity");
  assert.equal(counts.seed_relations_written, COUPLING_RELATIONS.length);
  assert.equal(f.db.rows("entity_aliases").length, 0, "no word of the vocabulary is written as a matchable alias: the flywheel matches no free-text words");
  const hvo = f.db.rows("entity_relations").find((x) => x.parent_entity_id === E("feed:lipid") && x.child_entity_id === E("carrier:hvo"));
  assert.equal(hvo?.relation, "feedstock_of");
  assert.ok(hvo?.source_id);
  assert.match(JSON.stringify(hvo?.provenance), /hydrogenation of vegetable oil or animal fat/);
  const kinds = new Set(f.db.rows("entity_relations").map((x) => x.relation));
  for (const k of ["feedstock_of", "fuel_for_mode", "competes_for_feedstock", "shares_grid_zone", "serves_hub", "corridor_links", "implements", "amends", "consignment_wide"]) assert.ok(kinds.has(k), `${k} is seeded`);
});

test("a second run writes nothing, and a dry run plans without writing", async () => {
  const f = fixture();
  await propagate(f);
  const before = [f.db.rows("entities").length, f.db.rows("entity_relations").length];
  const again = await seedCouplings({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.deepEqual([again.counts.seed_entities_written, again.counts.seed_relations_written], [0, 0]);
  const dry = await seedCouplings({ sb: f.d.sb, now: () => NOW }, { dry: true });
  assert.equal(dry.counts.seed_entities_planned, COUPLINGS.length);
  assert.deepEqual([f.db.rows("entities").length, f.db.rows("entity_relations").length], before);
});

test("planted: a page whose capture does not hold the quote refuses its couplings and every relation resting on them; nothing is written ungrounded", async () => {
  const url = couplingByKey("carrier:hvo")?.citation?.url as string;
  const f = fixture({ routes: { [url]: () => new Response(`${"A page that no longer says it. ".repeat(60)}`, { status: 200, headers: { "content-type": "text/plain" } }) } });
  await propagate(f);
  const counts = (f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outputs as { counts: Record<string, number> }).counts;
  const gone = COUPLINGS.filter((c) => c.citation?.url === url).length;
  assert.equal(counts.seed_refused, gone, "the couplings the page grounds");
  assert.ok(gone > 0);
  assert.ok(!f.db.rows("entities").some((e) => e.entity_id === E("carrier:hvo")), "the refused coupling is not an entity");
  assert.ok(!f.db.rows("entity_relations").some((x) => x.child_entity_id === E("carrier:hvo") || x.parent_entity_id === E("carrier:hvo")), "no relation rests on it");
  assert.ok(f.db.rows("entities").some((e) => e.entity_id === E("feed:lipid")), "the rest is seeded");
  assert.equal(f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outcome, "partial", "a refused coupling is a gap in the vocabulary: the run says so");
});

test("the relations run from a lower class rank to a higher one, so the vocabulary holds no cycle", () => {
  const rank = (key: string): number => ({ instrument: 0, mandate: 0, feedstock: 1, carrier: 2, node: 3, hub: 4, corridor: 4, mode: 5, attribute: 6, window: 6 })[couplingByKey(key)?.class as string] as number;
  for (const r of COUPLING_RELATIONS) assert.ok(rank(r.child) >= rank(r.parent), `${r.parent} ${r.relation} ${r.child}`);
  // within a rank the pairs are ordered one way only: no pair appears in both directions
  const pairs = new Set(COUPLING_RELATIONS.map((r) => `${r.parent}>${r.child}`));
  for (const r of COUPLING_RELATIONS) assert.ok(!pairs.has(`${r.child}>${r.parent}`), `${r.parent} and ${r.child} relate both ways`);
});

test("the entity ids stored in couplings.json are the ids the spine mints for the same kind and name", () => {
  for (const c of COUPLINGS) assert.equal(c.entityId, entityId(c.kind, c.name), c.key);
});

test("join completeness (scope review G2): every entity that sits on a leg names its legs with a quote, carries a relation, and every corridor links every mode it names", () => {
  const withoutLegs = new Set(["attribute", "window"]);
  const related = new Set(COUPLING_RELATIONS.flatMap((r) => [r.parent, r.child]));
  const legs = COUPLINGS.filter((c) => !withoutLegs.has(c.class));
  assert.deepEqual(legs.filter((c) => !(c.modeAgnostic || c.modes?.length)).map((c) => c.key), [], "an entity with no mode and not mode-agnostic can never join a leg");
  assert.deepEqual(legs.filter((c) => !related.has(c.key)).map((c) => c.key), [], "an entity with no relation is a dead end for every pattern");
  assert.deepEqual(legs.filter((c) => c.class === "instrument" && !c.modesCitation).map((c) => c.key), [], "an instrument carries the quote that names its legs");
  for (const corridor of COUPLINGS.filter((c) => c.class === "corridor")) {
    const linked = new Set(COUPLING_RELATIONS.filter((r) => r.parent === corridor.key && r.relation === "corridor_links").map((r) => r.child.replace(/^mode:/, "")));
    assert.deepEqual((corridor.modes ?? []).filter((m) => !linked.has(m)), [], `${corridor.key} names modes it does not link`);
  }
});
