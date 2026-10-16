import assert from "node:assert/strict";
import { test } from "node:test";

import { POST, setIntakeDepsFactory } from "@/features/intake/api/run";

import { fakeDb } from "../_support/fake-db.ts";
import { PERSONAS, as, json, script, type Persona } from "../_support/personas.ts";

import { factClaim, ITEM, makeWorld, marketSignalBody, metadata, poolHashOf, SPAN_PENALTY, SPAN_REPORT } from "./fixtures.ts";

const wire = (w = makeWorld()) => {
  script({ db: w.db.client } as unknown as ReturnType<typeof fakeDb>);
  setIntakeDepsFactory(() => w.deps);
  return w;
};
const body = (w: ReturnType<typeof makeWorld>, over: Record<string, unknown> = {}) => json({ itemId: ITEM, injected: { body: marketSignalBody(), metadata: metadata(), sourcePoolHash: poolHashOf(w.db), ledger: [factClaim(SPAN_REPORT), factClaim(SPAN_PENALTY, { section: "4" })] }, ...over });
const call = async (persona: Persona, payload: string) => POST(as(persona, "/api/agent/run", { method: "POST", body: payload }), undefined as never);

test("INV-161: persona matrix for POST /api/agent/run: anon 401, every non-admin 403, platform admin 200", async () => {
  const expected: Record<Persona, number> = { anon: 401, viewer: 403, otherOrgMember: 403, member: 403, owner: 403, platformAdmin: 200 };
  for (const persona of PERSONAS) {
    const w = wire();
    const res = await call(persona, body(w));
    assert.equal(res.status, expected[persona], `${persona}`);
    if (persona !== "platformAdmin") assert.equal(w.db.writes("intelligence_items").length, 0, `${persona} wrote nothing`);
  }
});

test("INV-161: an admin run returns the workflow result; a SECOND run within the hour is 429 (refresh does not bypass it)", async () => {
  const w = wire();
  const first = await call("platformAdmin", body(w));
  assert.equal(first.status, 200);
  const data = (await first.json()) as { status: string; steps: Record<string, string> };
  assert.equal(data.status, "verified", JSON.stringify(data));
  assert.ok(data.steps.ground);
  assert.equal(w.db.rows("intelligence_items")[0]?.provenance_status, "verified");
  assert.equal((await call("platformAdmin", json({ itemId: ITEM }))).status, 200, "a verified item short-circuits before the cooldown");
  w.db.rows("intelligence_items")[0]!.provenance_status = "quarantined";
  const again = await call("platformAdmin", json({ itemId: ITEM }));
  assert.equal(again.status, 429);
  assert.equal(((await again.json()) as { error: string }).error, "cooldown");
  assert.equal((await call("platformAdmin", json({ itemId: ITEM, refresh: true }))).status, 429, "refresh does not bypass the cooldown");
});

test("INV-161: a verified item short-circuits with 200 unless refresh is passed", async () => {
  const w = wire();
  w.db.rows("intelligence_items")[0]!.provenance_status = "verified";
  const res = await call("platformAdmin", json({ itemId: ITEM }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: "already_verified", item_id: ITEM, hint: "pass { refresh: true } to force a regeneration" });
  assert.equal(w.db.rows("agent_runs").length, 0);
  assert.equal((await call("platformAdmin", json({ itemId: ITEM, refresh: true }))).status, 200);
  assert.ok(w.db.rows("agent_runs").length > 0, "refresh proceeds to the workflow");
});

test("INV-161 fail-closed: a failed guard read is 503 guard_unavailable and the workflow does not start", async () => {
  const a = wire();
  a.db.failWhen = (c) => (c.table === "intelligence_items" && c.op === "select" ? "pool exhausted" : null);
  const ra = await call("platformAdmin", body(a));
  assert.equal(ra.status, 503);
  assert.equal(((await ra.json()) as { error: string }).error, "guard_unavailable");
  const b = wire();
  b.db.failWhen = (c) => (c.table === "agent_runs" && c.op === "select" ? "timeout" : null);
  assert.equal((await call("platformAdmin", body(b))).status, 503);
  assert.equal(b.db.rows("agent_runs").length, 0);
  assert.equal(b.db.rows("section_claim_provenance").length, 0, "nothing ran");
});

test("request validation: itemId or sourceUrl is required; sourceUrl resolves to the item or 404; an unwired runtime is 503, never a silent success", async () => {
  const w = wire();
  assert.equal((await call("platformAdmin", json({}))).status, 400);
  assert.equal((await call("platformAdmin", "not json")).status, 400);
  assert.equal((await call("platformAdmin", json({ sourceUrl: "https://nowhere.test/x" }))).status, 404);
  const bySource = await call("platformAdmin", json({ sourceUrl: w.db.rows("intelligence_items")[0]!.source_url, dry: true, injected: JSON.parse(body(w)).injected }));
  assert.equal(bySource.status, 200);
  assert.equal(((await bySource.json()) as { item_id: string }).item_id, ITEM);
  const lookupFail = wire();
  lookupFail.db.failWhen = (c) => (c.table === "intelligence_items" && c.op === "select" ? "down" : null);
  assert.equal((await call("platformAdmin", json({ sourceUrl: "https://x.test/y" }))).status, 503, "a failed lookup is a 503, not a 404");
  wire();
  setIntakeDepsFactory(null);
  assert.equal((await call("platformAdmin", json({ itemId: ITEM }))).status, 503);
});
