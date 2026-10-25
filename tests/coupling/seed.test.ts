// CONNECT-2 C1: the seeds pass writes every coupling of couplings.json, each grounded: its quote stands verbatim on a captured page the class table rates, and the row records that source. A quote no capture holds is refused and counted, never written ungrounded; a second run writes nothing;
// a dry run plans the same counts and writes nothing; the relations form no cycle (the table's own trigger would refuse one).
import assert from "node:assert/strict";
import { test } from "node:test";

import { COUPLING_RELATIONS, COUPLINGS, couplingByKey } from "@/core/coupling";
import { seedCouplings } from "@/core/coupling";

import { fixture, NOW } from "../integration/world.ts";

import { E, propagate } from "./_world.ts";

test("the propagate stage captures the cited pages and seeds every coupling, each entity and relation carrying the source it is taken from and the quote", async () => {
  const f = fixture();
  const r = await propagate(f);
  assert.equal(r.exit, 0);
  const counts = (f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outputs as { counts: Record<string, number> }).counts;
  assert.equal(counts.seed_refused, 0);
  assert.equal(counts.seed_entities_written, COUPLINGS.length + 0, "every coupling is an entity (the instruments are new in the fixture)");
  assert.equal(counts.seed_relations_written, COUPLING_RELATIONS.length);
  const aliases = f.db.rows("entity_aliases");
  assert.ok(aliases.length > COUPLINGS.length);
  const windows = new Set(COUPLINGS.filter((c) => c.class === "window").map((c) => c.entityId));
  for (const a of aliases.filter((x) => !windows.has(String(x.entity_id)))) assert.ok(a.source_id, `${String(a.alias)}: an alias carries its source (a time window is a definition, not a published fact)`);
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
  const before = [f.db.rows("entities").length, f.db.rows("entity_aliases").length, f.db.rows("entity_relations").length];
  const again = await seedCouplings({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.deepEqual([again.counts.seed_entities_written, again.counts.seed_aliases_written, again.counts.seed_relations_written], [0, 0, 0]);
  const dry = await seedCouplings({ sb: f.d.sb, now: () => NOW }, { dry: true });
  assert.equal(dry.counts.seed_entities_planned, COUPLINGS.length);
  assert.deepEqual([f.db.rows("entities").length, f.db.rows("entity_aliases").length, f.db.rows("entity_relations").length], before);
});

test("planted: a page whose capture does not hold the quote refuses its couplings and every relation resting on them; nothing is written ungrounded", async () => {
  const url = couplingByKey("carrier:hvo")?.citation?.url as string;
  const f = fixture({ routes: { [url]: () => new Response(`${"A page that no longer says it. ".repeat(60)}`, { status: 200, headers: { "content-type": "text/plain" } }) } });
  await propagate(f);
  const counts = (f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outputs as { counts: Record<string, number> }).counts;
  const gone = COUPLINGS.filter((c) => c.citation?.url === url).length;
  assert.equal(counts.seed_refused, gone);
  assert.ok(gone > 0);
  assert.ok(!f.db.rows("entities").some((e) => e.entity_id === E("carrier:hvo")), "the refused coupling is not an entity");
  assert.ok(!f.db.rows("entity_relations").some((x) => x.child_entity_id === E("carrier:hvo") || x.parent_entity_id === E("carrier:hvo")), "no relation rests on it");
  assert.ok(f.db.rows("entities").some((e) => e.entity_id === E("feed:lipid")), "the rest is seeded");
});

test("the relations run from a lower class rank to a higher one, so the vocabulary holds no cycle", () => {
  const rank = (key: string): number => ({ instrument: 0, mandate: 0, feedstock: 1, carrier: 2, node: 3, hub: 4, corridor: 4, mode: 5, attribute: 6, window: 6 })[couplingByKey(key)?.class as string] as number;
  for (const r of COUPLING_RELATIONS) assert.ok(rank(r.child) >= rank(r.parent), `${r.parent} ${r.relation} ${r.child}`);
  // within a rank the pairs are ordered one way only: no pair appears in both directions
  const pairs = new Set(COUPLING_RELATIONS.map((r) => `${r.parent}>${r.child}`));
  for (const r of COUPLING_RELATIONS) assert.ok(!pairs.has(`${r.child}>${r.parent}`), `${r.parent} and ${r.child} relate both ways`);
});
