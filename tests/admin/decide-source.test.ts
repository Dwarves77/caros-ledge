import assert from "node:assert/strict";
import { test } from "node:test";

import { decideSourceCandidate, type DecisionInput } from "@/features/admin/api/source-decisions";

import { fakeDb, wrote, type Call, type Reply } from "../_support/fake-db.ts";

const CAND = "88888888-8888-4888-8888-888888888888";
const ITEM = "99999999-9999-4999-8999-999999999999";
const SRC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-10-16T12:00:00.000Z";
const PLACED = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R0956";
const UNPLACED = "https://consult.citizenspace.com/dept/page";

interface World {
  url?: string;
  decision?: string;
  registry?: Reply;
  hit?: { id: string; url: string };
  auditFails?: boolean;
  linkFails?: boolean;
  markFails?: boolean;
}
function world(w: World = {}) {
  return fakeDb((c: Call) => {
    if (c.table === "canonical_source_candidates" && c.op === "select") return { data: { id: CAND, decision: w.decision ?? "pending", candidate_url: w.url ?? PLACED, candidate_title: "Title", candidate_publisher: "Publisher", intelligence_item_id: ITEM } };
    if (c.table === "canonical_source_candidates" && c.op === "update") return w.markFails ? { error: { message: "mark down" } } : { data: [{ id: CAND }] };
    if (c.table === "sources" && c.op === "select" && c.columns?.startsWith("id, url")) return w.registry ?? { data: w.hit ? [w.hit] : [] };
    if (c.table === "sources" && c.op === "select") return { data: [] };
    if (c.table === "sources" && c.op === "insert") return { data: { id: SRC } };
    if (c.table === "sources" && c.op === "update") return { data: [{ id: SRC }] };
    if (c.table === "source_trust_events") return w.auditFails ? { error: { message: "audit down" } } : { data: [{ id: "e1" }] };
    if (c.table === "intelligence_items" && c.op === "update") return w.linkFails ? { error: { message: "link down" } } : { data: [{ id: ITEM }] };
    return undefined;
  });
}
const approve = (over: Partial<DecisionInput> = {}): DecisionInput => ({ kind: "canonical", id: CAND, decision: "approve", ...over });

test("a new source is born at the class table's tier, with one checked audit row, the item linked and the candidate closed (INV-176, INV-287, INV-288)", async () => {
  const w = world();
  const r = await decideSourceCandidate(w.db, ACTOR, approve(), NOW);
  assert.equal(r.status, "approved");
  const [ins] = wrote(w.calls, "sources", "insert");
  assert.ok(ins, "the source was inserted");
  assert.equal(typeof (ins.payload as { base_tier: unknown }).base_tier, "number");
  assert.equal(wrote(w.calls, "source_trust_events", "insert").length, 1, "one audit row");
  assert.equal((wrote(w.calls, "source_trust_events", "insert")[0]!.payload as { created_by: string }).created_by, "human");
  assert.equal(wrote(w.calls, "intelligence_items", "update").length, 1, "the item is linked");
  assert.equal((wrote(w.calls, "canonical_source_candidates", "update")[0]!.payload as { decision: string }).decision, "approved");
});

test("dedup fails closed: an unreadable registry refuses with 503 before any insert (INV-005)", async () => {
  const w = world({ registry: { error: { message: "registry down" } } });
  const r = await decideSourceCandidate(w.db, ACTOR, approve(), NOW);
  assert.equal(r.status, "refused");
  assert.equal(r.status === "refused" && r.httpStatus, 503);
  assert.equal(wrote(w.calls, "sources", "insert").length, 0, "no duplicate was minted");
  assert.equal(wrote(w.calls, "canonical_source_candidates", "update").length, 0, "the candidate stays open");
});

test("a source already at the canonical URL is reused, never duplicated", async () => {
  const w = world({ hit: { id: SRC, url: PLACED } });
  const r = await decideSourceCandidate(w.db, ACTOR, approve(), NOW);
  assert.equal(r.status === "approved" && r.reused, true);
  assert.equal(wrote(w.calls, "sources", "insert").length, 0);
});

test("a host the class table cannot place needs the operator's tier: refused 400 singly, handed back as review in bulk, and an operator tier lands as an override with a reason, never as base_tier", async () => {
  const single = await decideSourceCandidate(world({ url: UNPLACED }).db, ACTOR, approve(), NOW);
  assert.equal(single.status === "refused" && single.httpStatus, 400);
  const bulk = await decideSourceCandidate(world({ url: UNPLACED }).db, ACTOR, approve({ bulk: true }), NOW);
  assert.equal(bulk.status, "review");
  const w = world();
  await decideSourceCandidate(w.db, ACTOR, approve({ assignedTier: 7, reviewerNotes: "chosen by the operator" }), NOW);
  const updates = wrote(w.calls, "sources", "update");
  assert.ok(updates.some((u) => (u.payload as { tier_override?: number }).tier_override === 7 && !!(u.payload as { override_reason?: string }).override_reason), "an override with its reason");
  assert.ok(updates.every((u) => !("base_tier" in (u.payload as object))), "base_tier is never written on an update");
});

test("an audit row that fails to write reports partial with what is durable, never approved (INV-288)", async () => {
  const w = world({ auditFails: true });
  const r = await decideSourceCandidate(w.db, ACTOR, approve(), NOW);
  assert.equal(r.status, "partial");
  assert.ok(r.status === "partial" && r.durable.some((d) => d.includes("created")) && r.remediation.length > 0);
  assert.equal(wrote(w.calls, "canonical_source_candidates", "update").length, 0, "the candidate is not closed over a half-written approval");
});

test("a failed item link or candidate mark after the source exists is partial, and an already-ruled candidate is 409", async () => {
  assert.equal((await decideSourceCandidate(world({ linkFails: true }).db, ACTOR, approve(), NOW)).status, "partial");
  assert.equal((await decideSourceCandidate(world({ markFails: true }).db, ACTOR, approve(), NOW)).status, "partial");
  await assert.rejects(decideSourceCandidate(world({ decision: "approved" }).db, ACTOR, approve(), NOW), (e: { status?: number }) => e.status === 409);
});

test("reject and defer close the candidate and create nothing", async () => {
  for (const decision of ["reject", "defer"] as const) {
    const w = world();
    const r = await decideSourceCandidate(w.db, ACTOR, approve({ decision }), NOW);
    assert.equal(r.status, decision === "reject" ? "rejected" : "deferred");
    assert.equal(wrote(w.calls, "sources", "insert").length, 0);
  }
});
