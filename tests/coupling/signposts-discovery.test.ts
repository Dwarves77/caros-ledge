// CONNECT-2 PR B, C5 and C6 and the packet eligibility rule: the signposts of the patterns are scored by the pattern step (held when the dated key row stands on its date, refuted when the key row moved or is gone), the discovery hook raises and closes needs-search rows, and a P1 pattern is packet-eligible only
// when it was computed on dated claims and one of its entities carries a reader-asserted relation.
import assert from "node:assert/strict";
import { test } from "node:test";

import { readPackets } from "@/core/digest/packets";
import { patternGaps } from "@/core/flywheel/gaps";
import { runPatterns, type Pattern } from "@/core/flywheel/patterns";
import { trackPatterns } from "@/core/flywheel/patterns/signposts";
import { PATTERN_METHODS } from "@/core/propagation/methods";

import { MemDb } from "../_support/memdb.ts";

import { connect, E, NOW, propagate } from "./_world.ts";
import { plantReaderRefs, ROW, triangleFixture } from "./_triangles.ts";

async function turn() {
  const f = triangleFixture();
  await propagate(f);
  plantReaderRefs(f);
  await connect(f);
  return f;
}
const at = (days: number) => () => new Date(NOW.getTime() + days * 86_400_000);
const outcomes = (f: Awaited<ReturnType<typeof turn>>) => f.db.rows("signposts").map((s) => `${String((s.predicate as { pattern: string }).pattern).split(":")[0]}=${String(s.outcome ?? "open")}`).sort();

test("C6: a pattern signpost holds when its key row stands on its date (the lead-lag pattern has left the detector's window by then and is not what is tested), and is scored once", async () => {
  const f = await turn();
  assert.deepEqual(outcomes(f), ["leadLag=open", "mandateCapacity=open", "mandateCapacity=open", "penaltyAbatement=open"]);
  const r = await runPatterns({ sb: f.d.sb, now: at(69) }, { dry: false });
  assert.deepEqual([r.counts.signposts_held, r.counts.signposts_refuted, r.counts.signposts_open], [1, 0, 3]);
  assert.deepEqual(outcomes(f), ["leadLag=held", "mandateCapacity=open", "mandateCapacity=open", "penaltyAbatement=open"]);
  const held = f.db.rows("signposts").find((s) => s.outcome === "held");
  assert.ok(held?.fired_at && held.lifecycle_applied_at && held.scored_by === "pattern_signpost@1" && held.outcome_assessed_at);
  const again = await runPatterns({ sb: f.d.sb, now: at(69) }, { dry: false });
  assert.deepEqual([again.counts.signposts_held, again.counts.signposts_refuted], [0, 0], "a scored signpost is never scored twice");
});

test("C6: a pattern signpost is refuted when the dated step it rests on moved or is gone, before its date; a dry run counts and writes nothing", async () => {
  const f = await turn();
  const trigger = f.db.rows("item_forward_events").find((e) => e.id === ROW.trigger) as Record<string, unknown>;
  trigger.event_date = new Date(NOW.getTime() + 100 * 86_400_000).toISOString().slice(0, 10);
  const dry = await runPatterns({ sb: f.d.sb, now: at(0) }, { dry: true });
  assert.equal(dry.counts.signposts_refuted, 1);
  assert.deepEqual(outcomes(f), ["leadLag=open", "mandateCapacity=open", "mandateCapacity=open", "penaltyAbatement=open"], "dry wrote nothing");
  await runPatterns({ sb: f.d.sb, now: at(0) }, { dry: false });
  assert.deepEqual(outcomes(f), ["leadLag=refuted", "mandateCapacity=open", "mandateCapacity=open", "penaltyAbatement=open"]);
  assert.equal(f.db.rows("signposts").find((s) => s.outcome === "refuted")?.fired_at ?? null, null, "a refutation is a score, not a firing");
  // the penalty-abatement pattern has no key date: it falls when it is no longer found (the technology's maturity drops under the floor)
  (f.db.rows("research_assessments")[0] as Record<string, unknown>).technical_maturity_low = 3;
  await runPatterns({ sb: f.d.sb, now: at(0) }, { dry: false });
  assert.ok(outcomes(f).includes("penaltyAbatement=refuted"));
});

test("C6: a tracked pattern none of whose evidence rows belongs to an item is counted, never dropped silently, and writes no signpost", async () => {
  const db = new MemDb();
  const p: Pattern = { kind: "leadLag", key: "k1", entity: "e1", value: 90, unit: "days", evidence: [{ table: "item_forward_events", pk: "t1", kind: "key", entities: ["e1"] }] };
  const r = await trackPatterns({ sb: db.client, now: () => NOW }, { dry: false, found: [p], facts: new Map() });
  assert.deepEqual([r.signposts_new, r.signposts_no_item], [0, 1]);
  assert.equal(db.rows("signposts").length, 0);
});

test("C5: the discovery hook raises one need per pending trigger without a resolving capture and closes it when a capture resolves it; a second turn raises none", async () => {
  const f = await turn();
  const open = () => f.db.rows("integrity_flags").filter((r) => String(r.created_by).startsWith("flywheel-gap:pattern_") && r.status === "open");
  assert.equal(open().length, 1);
  await connect(f);
  assert.equal(open().length, 1, "the same need is not raised twice");
  (f.db.rows("item_forward_events").find((e) => e.id === ROW.trigger) as Record<string, unknown>).resolved_at = `${NOW.toISOString().slice(0, 10)}T00:00:00Z`;
  const r = await runPatterns({ sb: f.d.sb, now: at(0) }, { dry: false });
  assert.equal(r.counts.pattern_needs_closed, 1);
  assert.equal(open().length, 0);
  assert.equal(f.db.rows("integrity_flags").find((x) => String(x.created_by).startsWith("flywheel-gap:pattern_"))?.status, "resolved");
});

test("C5: a hop the reader names with no recent row under its far end is a need naming the surface, the entity, the window and the venue class; with a recent row there is none", () => {
  const pattern: Pattern = { kind: "crossModal", key: "a|competes_for_feedstock|b", entity: E("carrier:bio_bunkers"), value: 0.5, unit: "strength", evidence: [{ table: "obligation_objects", pk: "o1", kind: "member", entities: [E("carrier:bio_bunkers")] }] };
  const edge = { parent: E("carrier:bio_bunkers"), child: E("node:shore_power"), relation: "implements" as const };
  const recent = { table: "section_claim_provenance", pk: "c1", role: "claim" as const, entities: [E("node:shore_power")], modes: [], surface: "market", at: NOW.toISOString().slice(0, 10), due: null, source: null, tier: null, qty: null, unit: null, trl: null, kind: "FACT", group: null };
  const gaps = patternGaps({ patterns: [pattern], facts: [], readerEdges: [edge], now: NOW });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.type, "pattern_hop_gap");
  assert.match(gaps[0]?.description ?? "", /Surface operations; entities cl:node:4aa80df87d7188f6; window the last 90 days; venue class: grid operator or port authority/);
  assert.deepEqual(patternGaps({ patterns: [pattern], facts: [recent], readerEdges: [edge], now: NOW }), [], "a recent row under the far end fills the hop");
  assert.deepEqual(patternGaps({ patterns: [pattern], facts: [], readerEdges: [], now: NOW }), [], "no reader-named hop, no need");
});

test("packets: a P1 pattern is packet-eligible only when computed on dated claims (the document-date clock's method version) and one of its entities carries a reader-asserted relation", async () => {
  const entity = E("carrier:hvo");
  const claim = "00000000-0000-4000-8000-0000000000c1";
  const db = (reader: boolean, version: string) =>
    new MemDb()
      .seed("section_claim_provenance", [{ id: claim, claim_text: "x", claim_kind: "FACT" }])
      .seed("entity_relations", [{ parent_entity_id: entity, child_entity_id: E("carrier:hefa_saf"), relation: "competes_for_feedstock", asserted_by: "t", ...(reader ? { basis: { quote: "q" }, method_version: "reader@t" } : {}) }])
      .seed("derived_values", [{ value_id: "00000000-0000-4000-8000-0000000000a1", entity_id: entity, method_id: PATTERN_METHODS.velocity.id, method_version: version, value: 3, unit: "ratio", admissibility: "analysis_ok", lifecycle: "emerging", computed_by: `${PATTERN_METHODS.velocity.id}@${version}:${entity}|30`, inputs: [{ table: "section_claim_provenance", pk: claim, kind: "member", entities: [entity] }] }]);
  const read = (reader: boolean, version: string) => readPackets(db(reader, version).client, ["00000000-0000-4000-8000-0000000000a1"]);
  assert.equal((await read(true, PATTERN_METHODS.velocity.version)).packets.length, 1);
  const noEdge = await read(false, PATTERN_METHODS.velocity.version);
  assert.deepEqual([noEdge.packets.length, noEdge.marker], [0, "packets: 1 of 1 ids have no live pattern packet; 1 P1 pattern(s) held back (undated or no reader-asserted edge)"], "dated, no reader edge");
  assert.equal((await read(true, "1.2.0")).packets.length, 0, "a reader edge, computed on item added dates");
});
