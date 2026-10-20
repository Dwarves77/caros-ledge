// R2d, I13 on the obligation readers (register flywheel:21, 23, 50): a suppressed claim takes its forward events off /upcoming, the register, its facets and the deadline column on the next read; an item that is
// unverified, archived or replaced is read by none of them, and no obligation object or extraction is made for it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractBackfill, fetchForwardEventCount, fetchObligationRegisterPage, fetchRegisterFacetOptions, readUpcoming, buildRegisterQuerySpec } from "@/features/obligations";
import { syncComplianceDeadline } from "@/features/obligations/derive/compliance-deadline";
import { deriveObligationObjects } from "@/features/obligations/derive/derive-objects";

import { memoryDb, type Row } from "../_support/memory-db.ts";

const TODAY = "2026-10-19";
const LIVE = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const item = (id: string, over: Row = {}): Row => ({ id, title: `Item ${id.slice(-1)}`, legacy_id: `i${id.slice(-1)}`, domain: 1, provenance_status: "verified", is_archived: false, replaced_by: null, jurisdiction_iso: ["EU"], transport_modes: ["road"], ...over });
const claim = (id: string, itemId: string, text: string): Row => ({ id, intelligence_item_id: itemId, claim_text: text, claim_kind: "FACT" });
const event = (id: string, itemId: string, claimId: string | null, over: Row = {}): Row => ({ id, intelligence_item_id: itemId, event_date: "2026-12-31", date_precision: "day", event_kind: "compliance_deadline", obligation_text: `text ${id}`, source_kind: claimId ? "claim" : "section", source_claim_id: claimId, confidence: claimId ? "high" : "medium", created_at: "2026-10-01T00:00:00Z", ...over });
const obligation = (id: string, itemId: string, eventId: string): Row => ({ id, intelligence_item_id: itemId, forward_event_id: eventId, jurisdiction: ["EU"], modes: ["road"], binding_position: "own_duty", due_date: "2026-12-31", date_precision: "day", event_kind: "compliance_deadline", status: "active" });
const suppress = (claimId: string, itemId: string, text: string): Row => ({ id: `s-${claimId}`, item_id: itemId, target_kind: "fact", target_ref: claimId, op: "suppress", machine_value: { claim_text: text }, created_at: "2026-10-18T00:00:00Z", revoked_at: null });

const C1 = "c0000000-0000-4000-8000-000000000001";
const C2 = "c0000000-0000-4000-8000-000000000002";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

function world(over: { items?: Row[]; suppressions?: Row[] } = {}) {
  return memoryDb({
    intelligence_items: over.items ?? [item(LIVE), item(OTHER)],
    section_claim_provenance: [claim(C1, LIVE, "The wrong deadline is 2026-12-31."), claim(C2, OTHER, "The right deadline.")],
    item_forward_events: [event(E1, LIVE, C1), event(E2, OTHER, C2), event(E3, LIVE, null, { event_date: "2026-11-30" })],
    obligations: [obligation("o1", LIVE, E1), obligation("o2", OTHER, E2), obligation("o3", LIVE, E3)],
    fact_suppressions: over.suppressions ?? [],
  });
}
const facetTotal = (f: { counts: { bindingPosition: Record<string, number> } }): number => Object.values(f.counts.bindingPosition).reduce((a, b) => a + b, 0);
const upcoming = async (m: ReturnType<typeof world>) => (await readUpcoming(m.db, { limit: 20 }, TODAY)).events.map((e) => e.id).sort();
const register = async (m: ReturnType<typeof world>) => {
  const r = await fetchObligationRegisterPage(m.db, buildRegisterQuerySpec({}, TODAY));
  return { ids: r.rows.map((x) => x.forward_event_id).sort(), total: r.total };
};

test("flywheel:21: suppress a claim and the event read from it disappears from /upcoming and from the register on the next read, the register's total agreeing with its page; the other events stay", async () => {
  const before = world();
  assert.deepEqual(await upcoming(before), [E1, E2, E3].sort());
  assert.deepEqual(await register(before), { ids: [E1, E2, E3].sort(), total: 3 });
  const after = world({ suppressions: [suppress(C1, LIVE, "The wrong deadline is 2026-12-31.")] });
  assert.deepEqual(await upcoming(after), [E2, E3].sort());
  assert.deepEqual(await register(after), { ids: [E2, E3].sort(), total: 2 });
  assert.equal(await fetchForwardEventCount(after.db), 2);
  assert.equal(facetTotal(await fetchRegisterFacetOptions(after.db, TODAY)), 2);
});

test("flywheel:21: a suppression matched by the claim's text (not its id) takes the event off too, and a revoked suppression takes nothing", async () => {
  const byText = world({ suppressions: [{ ...suppress("not-the-id", LIVE, "The wrong deadline is 2026-12-31."), target_ref: "some-older-claim-id" }] });
  assert.deepEqual(await upcoming(byText), [E2, E3].sort());
  const revoked = world({ suppressions: [{ ...suppress(C1, LIVE, "The wrong deadline is 2026-12-31."), revoked_at: "2026-10-19T00:00:00Z" }] });
  assert.deepEqual(await upcoming(revoked), [E1, E2, E3].sort());
});

test("flywheel:21: a failed read of the suppressions fails /upcoming, the register and the deadline sync; an event is never shown because the suppressions could not be read", async () => {
  const m = memoryDb({ intelligence_items: [item(LIVE)], item_forward_events: [event(E1, LIVE, C1)], obligations: [] }, { failures: [{ table: "fact_suppressions", op: "select", message: "down" }] });
  await assert.rejects(() => readUpcoming(m.db, { limit: 5 }, TODAY), /down/);
  await assert.rejects(() => fetchObligationRegisterPage(m.db, buildRegisterQuerySpec({}, TODAY)), /down/);
  await assert.rejects(() => syncComplianceDeadline(m.db, LIVE, TODAY), /down/);
});

test("flywheel:21: the deadline column is the earliest event that survives suppression, not the suppressed one", async () => {
  const m = memoryDb({
    intelligence_items: [item(LIVE, { compliance_deadline: null })],
    section_claim_provenance: [claim(C1, LIVE, "The wrong deadline.")],
    item_forward_events: [event(E1, LIVE, C1, { event_date: "2026-11-01" }), event(E3, LIVE, null, { event_date: "2026-12-15" })],
    fact_suppressions: [suppress(C1, LIVE, "The wrong deadline.")],
  });
  const r = await syncComplianceDeadline(m.db, LIVE, TODAY);
  assert.deepEqual(r, { changed: true, value: "2026-12-15" });
});

test("I13: an item that is unverified, archived or replaced is read by no obligation reader", async () => {
  for (const [name, gone] of [["unverified", { provenance_status: "unverified" }], ["archived", { is_archived: true }], ["replaced", { replaced_by: OTHER }]] as const) {
    const m = world({ items: [item(LIVE, gone), item(OTHER)] });
    assert.deepEqual(await upcoming(m), [E2], `${name}: /upcoming`);
    assert.deepEqual(await register(m), { ids: [E2], total: 1 }, `${name}: register`);
    assert.equal(await fetchForwardEventCount(m.db), 1, `${name}: the honest-empty count counts only what a reader can see`);
    assert.equal(facetTotal(await fetchRegisterFacetOptions(m.db, TODAY)), 1, `${name}: facets`);
  }
});

test("flywheel:50: the backfill extracts for admissible items only: not for an unverified, archived or replaced one", async () => {
  const m = memoryDb({ intelligence_items: [item(LIVE), item(OTHER, { provenance_status: "unverified" }), item("10000000-0000-4000-8000-000000000003", { replaced_by: LIVE }), item("10000000-0000-4000-8000-000000000004", { is_archived: true })], item_forward_events: [], section_claim_provenance: [], intelligence_item_sections: [] });
  const r = await extractBackfill({ sb: m.db, now: () => new Date(`${TODAY}T00:00:00Z`) }, { dry: true });
  assert.equal(r.counts.scope, 1);
});

test("flywheel:23: no obligation object is derived for an unverified item, nor from a suppressed claim", async () => {
  const claimText = "Article 4(2): carriers shall report their emissions annually.";
  const base = (itemOver: Row, suppressions: Row[]) =>
    memoryDb({
      intelligence_items: [item(LIVE, { instrument_identifier: "Reg X", canonical_instrument_key: "x", ...itemOver })],
      section_claim_provenance: [{ ...claim(C1, LIVE, claimText), source_span: claimText, search_result_id: "r1", source_id: null }],
      agent_run_searches: [{ id: "r1", intelligence_item_id: LIVE, result_content: claimText }],
      item_forward_events: [],
      obligation_objects: [],
      fact_suppressions: suppressions,
    });
  const live = await deriveObligationObjects(base({}, []).db, { dry: true, itemIds: [LIVE] });
  assert.ok((live.counts.candidates ?? 0) >= 1, "the fixture yields a candidate when nothing is wrong");
  const unverified = await deriveObligationObjects(base({ provenance_status: "unverified" }, []).db, { dry: true, itemIds: [LIVE] });
  assert.equal(unverified.counts.candidates, 0);
  const suppressed = await deriveObligationObjects(base({}, [suppress(C1, LIVE, claimText)]).db, { dry: true, itemIds: [LIVE] });
  assert.equal(suppressed.counts.candidates, 0);
});
