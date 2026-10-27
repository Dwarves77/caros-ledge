// CONNECT-2 PR B, the acceptance test (unified design section 4): the three triangles of TRIANGLE-TRACE Q2 planted on an isolated fixture database, one turn, and exactly the planted patterns come out: Triangle 1 crossModal at 0.48 (0.8 x (1 - 36/90)) and penaltyAbatement at ratio 12.5; Triangle 2 mandateCapacity at 13.0 and 11.0 months;
// Triangle 3 leadLag at 68 days and crossModal at 0.49 (0.5 x (1 - 2/90)) with the lane's corridor_links edge. One packet per pattern, a brief that cites only packet ids, signposts and one needs-search row, and a second turn that writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { uuidOf } from "@/core/coupling";
import { citableIds, readPackets, uncitedIds } from "@/core/digest/packets";

import { connect, countsOf, E, patterns, propagate } from "./_world.ts";
import { ITEM, OBL, plantReaderRefs, triangleFixture } from "./_triangles.ts";

const keyOf = (r: Record<string, unknown>): string => String(r.computed_by).slice(String(r.computed_by).indexOf(":") + 1);
async function turn(over: { endedCeiling?: boolean } = {}) {
  const f = triangleFixture(over);
  assert.equal((await propagate(f)).exit, 0);
  plantReaderRefs(f);
  assert.equal((await connect(f)).exit, 0);
  return f;
}
const table = (f: Awaited<ReturnType<typeof turn>>) => patterns(f).map((r) => `${String(r.method_id).replace("pattern_", "")} ${Number(r.value).toFixed(2)} ${String(r.unit)}`).sort();

test("the fixture turn yields exactly the planted patterns: one per kind and one per relation kind, and no velocity pattern (no claim is dated)", async () => {
  const f = await turn();
  assert.deepEqual(table(f), ["cross_modal 0.48 strength", "lead_lag 68.00 days", "mandate_capacity 11.00 months", "mandate_capacity 13.00 months", "penalty_abatement 12.50 ratio"]);
  const cross = patterns(f).filter((r) => r.method_id === "pattern_cross_modal").map((r) => keyOf(r).split("|")[1]).sort();
  assert.deepEqual(cross, ["competes_for_feedstock"]); // the lane corridor is linked to its mode, so its modes are the mode's: a move on the lane crosses to no other mode, and no pattern says it does
  const counts = countsOf(f, "corpus-turn");
  assert.deepEqual([counts.patterns, counts.patterns_velocity, counts.patterns_mandateCapacity, counts.patterns_leadLag, counts.patterns_crossModal, counts.patterns_penaltyAbatement], [5, 0, 2, 1, 1, 1]);
  // the edges: the lead-lag pattern rests on the trigger, the reroute and the rate move; the abatement pattern on the technology, the cost and the ceiling
  const edges = (method: string) => f.db.rows("derivation_edges").filter((e) => e.to_value_id === patterns(f).find((p) => p.method_id === method)?.value_id).map((e) => `${String(e.edge_kind)}:${String(e.from_table)}`).sort();
  assert.deepEqual(edges("pattern_lead_lag"), ["evidence:market_series", "evidence:reroute_events", "key:item_forward_events"]);
  assert.deepEqual(edges("pattern_penalty_abatement"), ["evidence:derived_values", "evidence:obligation_objects", "key:research_assessments"]);
});

test("one packet per pattern: every member row carries its item's provenance_status, the spans it holds and the refs with their bases; a brief cites only packet ids", async () => {
  const f = await turn();
  const ids = patterns(f).map((r) => String(r.value_id));
  const read = await readPackets(f.d.sb, ids);
  assert.equal(read.marker, null);
  assert.deepEqual(read.packets.map((p) => p.id).sort(), [...ids].sort());
  const fueleu = read.packets.find((p) => p.pattern?.kind === "crossModal" && p.members.some((m) => m.id === OBL.fueleu));
  const step = fueleu?.members.find((m) => m.id === OBL.fueleu);
  assert.equal(step?.provenance_status, "quarantined", "a quarantined item's row is in the packet and says so");
  assert.equal(step?.edge, "member");
  assert.ok(fueleu?.refs.some((r) => r.method_version === "reader@fixture" && (r.basis as { quote?: string }).quote?.includes("Bio-bunkers")), "the reader's ref and its quote");
  assert.ok(fueleu?.relations.some((r) => r.relation === "competes_for_feedstock"));
  assert.ok(read.packets.every((p) => p.members.every((m) => m.item_id === null || m.provenance_status !== null)), "no item-bound row without its provenance status");
  assert.ok(read.packets.every((p) => p.cap.members_omitted === 0 && p.cap.max_members > 0), "the cap is stated inside the packet");
  const leadLag = read.packets.find((p) => p.pattern?.kind === "leadLag");
  assert.deepEqual(leadLag?.signposts.map((s) => s.direction), ["confirms"]);
  // the dry-run brief of each packet cites packet ids only; an id outside the packet is refused
  for (const p of read.packets) {
    const cited = [p.id, ...p.members.slice(0, 3).map((m) => m.id)];
    assert.deepEqual(uncitedIds(p, cited), [], "a brief citing a packet's own ids is clean");
    assert.deepEqual(uncitedIds(p, [...cited, "cl:obligation:ffffffffffffffff"]), ["cl:obligation:ffffffffffffffff"], "an id the packet does not contain is refused");
    assert.ok(citableIds(p).has(p.pattern?.value_id as string));
  }
  // the packets that include an item are served by the item's id
  const byItem = await readPackets(f.d.sb, [ITEM.fueleu]);
  assert.ok(byItem.packets.length >= 1 && byItem.packets.every((p) => p.members.some((m) => m.table === "intelligence_items" && m.id === ITEM.fueleu)));
});

test("signposts and the needs-search row: each mandate-capacity, lead-lag and penalty-abatement pattern tracks an inference record and no assessment; the pending maritime step with no resolving capture is one open need", async () => {
  const f = await turn();
  const counts = countsOf(f, "corpus-turn");
  assert.deepEqual([counts.signposts_new, counts.signposts_no_item, counts.signposts_open], [4, 0, 0]);
  const posts = f.db.rows("signposts");
  assert.equal(posts.length, 4);
  assert.ok(posts.every((s) => (s.assessment_id ?? null) === null) && posts.every((s) => s.inference_record_id));
  const records = f.db.rows("inference_records");
  assert.ok(records.every((r) => r.status_token === "HYPOTHESIS" && String(r.method_id).startsWith("pattern_") && Array.isArray(r.cited_item_ids) && (r.cited_item_ids as string[]).length > 0));
  const needs = f.db.rows("integrity_flags").filter((r) => String(r.created_by).startsWith("flywheel-gap:pattern_"));
  assert.equal(needs.length, 1, "one needs-search row");
  assert.equal(needs[0]?.created_by, "flywheel-gap:pattern_trigger_gap");
  assert.equal(needs[0]?.status, "open");
  assert.match(String(needs[0]?.description), /Missing vertex: the capture that states it\. Surface regulations; entities .*window .* to .*venue class: docket or gazette/);
  assert.equal(counts.pattern_needs_raised, 1);
});

test("a second turn writes nothing: the same patterns, the same signposts and the same need", async () => {
  const f = await turn();
  const sizes = () => ["derived_values", "derivation_edges", "inference_records", "signposts", "integrity_flags", "entities", "entity_refs"].map((t) => f.db.rows(t).length);
  const before = sizes();
  assert.equal((await connect(f)).exit, 0);
  assert.deepEqual(sizes(), before);
  const c = countsOf(f, "corpus-turn");
  assert.deepEqual([c.patterns, c.patterns_unchanged, c.patterns_new, c.patterns_superseded, c.patterns_obsolete, c.signposts_new, c.pattern_needs_raised], [5, 5, 0, 0, 0, 0, 0]);
});

test("an ended ceiling yields no penalty-abatement pattern: the EUR 40 transitional ceiling (in force 2005 to 2007, same unit as the cost) stands beside the live EUR 100 one and the turn still yields the one pattern at 12.5, not a second at 31.25", async () => {
  const f = await turn({ endedCeiling: true });
  assert.equal(f.db.rows("obligation_objects").filter((o) => o.obligation_id === OBL.ended).length, 1, "the ended ceiling is in the database");
  assert.deepEqual(patterns(f).filter((p) => p.method_id === "pattern_penalty_abatement").map((p) => Number(p.value)), [12.5]);
  assert.deepEqual(table(f), ["cross_modal 0.48 strength", "lead_lag 68.00 days", "mandate_capacity 11.00 months", "mandate_capacity 13.00 months", "penalty_abatement 12.50 ratio"]);
});

test("a ratchet filed under mode:ocean yields one cross-modal pattern for its own step, not one per relation of the mode: the FuelEU step is filed under Bio-bunkers, its instrument and mode:ocean", async () => {
  const f = await turn();
  const filed = f.db.rows("entity_refs").filter((r) => r.ref_table === "obligation_objects" && r.ref_id === uuidOf(OBL.fueleu)).map((r) => r.entity_id);
  assert.ok(filed.includes(E("mode:ocean")) && filed.includes(E("carrier:bio_bunkers")), "the step is filed under the mode as well");
  assert.equal(patterns(f).filter((p) => p.method_id === "pattern_cross_modal" && keyOf(p).startsWith(OBL.fueleu)).length, 1);
});
