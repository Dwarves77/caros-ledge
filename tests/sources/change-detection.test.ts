// Change detection over three fixture sources (changed, unchanged, 403): a non-answer never evicts (INV-066 as built into the three-way classifier).
import assert from "node:assert/strict";
import { test } from "node:test";

import { contentFingerprint, isContentChange, runChangeDetection, validateCheckLimit } from "@/core/capture/change-detection";
import { fetchDirect } from "@/core/fetch/direct";
import { decideSourceAssessment, REACH } from "@/core/fetch/reachability";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-12T10:00:00Z");
const prose = (n: number, tag = "") => `${tag} The regulation requires operators to report greenhouse gas emissions under the scheme each year. `.repeat(n);
const page = (body: string) => `<html><head><title>T</title></head><body><p>${body}</p></body></html>`;
const ok = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const system = { id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false };
const src = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, url: `https://${id}.gov/p`, base_tier: 2, status: "active", processing_paused: false, auto_run_enabled: true, last_checked: null, consecutive_accessible: 0, successful_checks: 0, total_checks: 0, last_content_hash: null, ...over });

async function hashOf(text: string, db: never) {
  const r = await fetchDirect("https://seed.gov/p", { db, env: {}, fetchImpl: (async () => ok(page(text))) as typeof fetch, caller: "manual-intake-run" }, { max: 1_000_000, keepHtml: true });
  return contentFingerprint(r.text);
}

test("the fingerprint ignores whitespace and case, and a thin or first observation is never a change", () => {
  assert.equal(contentFingerprint("Hello   World"), contentFingerprint(" hello world "));
  assert.equal(isContentChange(null, "abc"), false);
  assert.equal(isContentChange("abc", null), false);
  assert.equal(isContentChange("abc", "abc"), false);
  assert.equal(isContentChange("abc", "abd"), true);
});
test("the limit is validated: absent is the default, a bad value is refused", () => {
  assert.deepEqual(validateCheckLimit(undefined), { ok: true, limit: 10 });
  assert.deepEqual(validateCheckLimit("25"), { ok: true, limit: 25 });
  for (const bad of ["0", "-1", "abc", "51", "1.5"]) assert.equal(validateCheckLimit(bad).ok, false, bad);
});

test("three fixtures: changed is flagged, unchanged is not, and a 403 is a non-answer that evicts nothing", async () => {
  const seed = memoryDb({ system_state: [system] });
  const before = await hashOf(prose(40), seed.db);
  const w = memoryDb({
    system_state: [system],
    sources: [src("altered", { last_content_hash: before, consecutive_accessible: 2 }), src("same", { last_content_hash: before, consecutive_accessible: 2 }), src("walled", { last_content_hash: before, consecutive_accessible: 0 })],
  });
  const fetchImpl = (async (u: string) => {
    if (u.includes("altered.gov")) return ok(page(prose(40, "amended")));
    if (u.includes("same.gov")) return ok(page(prose(40)));
    return new Response("forbidden", { status: 403 });
  }) as unknown as typeof fetch;
  const snaps: string[] = [];
  const run = await runChangeDetection({ db: w.db, now: () => NOW, env: {}, fetchImpl, writeSnapshot: async (id) => void snaps.push(id) });
  assert.equal(run.counts.checked, 3);
  assert.equal(run.counts.changes_detected, 1);
  const by = Object.fromEntries((run.data?.results ?? []).map((r) => [r.source, r]));
  assert.equal(by.altered?.changeDetected, true);
  assert.equal(by.same?.changeDetected, false);
  assert.equal(by.walled?.changeDetected, false);
  assert.equal(by.walled?.httpStatus, 403);
  const row = (id: string) => w.tables.sources?.find((s) => s.id === id) ?? {};
  assert.equal(row("walled").status, "active", "a 403 never evicts");
  assert.equal(row("walled").last_content_hash, before, "a non-answer keeps the last hash");
  assert.equal(row("altered").last_content_hash === before, false);
  assert.equal(row("same").last_content_hash, before);
  assert.deepEqual(snaps, ["altered"], "only a change stores a snapshot");
  const queue = Object.fromEntries((w.tables.monitoring_queue ?? []).map((q) => [q.source_id, q.last_result]));
  assert.deepEqual(queue, { altered: "updated", same: "no_change", walled: "error" });
  assert.equal(w.tables.source_trust_events?.length, 3);
});
test("only a definitive 404 with a zero streak evicts; a streak protects, and a 410 is the same", async () => {
  const w = memoryDb({ system_state: [system], sources: [src("gone0", { consecutive_accessible: 0 }), src("gone5", { consecutive_accessible: 5 }), src("gone410", { consecutive_accessible: 0 })] });
  const fetchImpl = (async (u: string) => new Response("nope", { status: String(u).includes("gone410") ? 410 : 404 })) as unknown as typeof fetch;
  await runChangeDetection({ db: w.db, now: () => NOW, env: {}, fetchImpl });
  const status = (id: string) => w.tables.sources?.find((s) => s.id === id)?.status;
  assert.equal(status("gone0"), "inaccessible");
  assert.equal(status("gone410"), "inaccessible");
  assert.equal(status("gone5"), "active");
});
test("a network error is a non-answer and evicts nothing; a recovered source reactivates", async () => {
  const w = memoryDb({ system_state: [system], sources: [src("flaky"), src("back", { status: "inaccessible", consecutive_accessible: 0 })] });
  w.tables.sources![1]!.status = "inaccessible";
  assert.equal(decideSourceAssessment({ outcome: REACH.INCONCLUSIVE, source: { consecutive_accessible: 0 } }).evictEligible, false);
  assert.equal(decideSourceAssessment({ outcome: REACH.REACHABLE, source: { status: "inaccessible" } }).reactivate, true);
  const fetchImpl = (async (u: string) => {
    if (String(u).includes("flaky")) throw new Error("ECONNRESET");
    return ok(page(prose(40)));
  }) as unknown as typeof fetch;
  const run = await runChangeDetection({ db: w.db, now: () => NOW, env: {}, fetchImpl });
  assert.equal(run.counts.checked, 1, "only active sources are selected");
  assert.equal(w.tables.sources?.find((s) => s.id === "flaky")?.status, "active");
});
test("build mode: with the cadence off nothing is fetched and nothing is written (rule 16)", async () => {
  const w = memoryDb({ system_state: [{ ...system, scrape_cadence: "off" }], sources: [src("a")] });
  let calls = 0;
  const run = await runChangeDetection({ db: w.db, now: () => NOW, env: {}, fetchImpl: (async () => (calls++, ok("x"))) as typeof fetch });
  assert.equal(run.counts.checked, 0);
  assert.equal(run.outcome, "ok");
  assert.equal(calls, 0);
  assert.equal(w.writes.length, 0);
});
test("off a scheduled scrape day nothing runs; the emergency stop halts a scheduled day", async () => {
  const offDay = memoryDb({ system_state: [system], sources: [src("a")] });
  const run = await runChangeDetection({ db: offDay.db, now: () => new Date("2026-10-13T10:00:00Z"), env: {}, fetchImpl: (async () => ok("x")) as typeof fetch });
  assert.equal(run.counts.checked, 0);
  assert.match(run.notes[0] ?? "", /not a scheduled scrape day/);
  const stopped = memoryDb({ system_state: [{ ...system, global_processing_paused: true }], sources: [src("a")] });
  assert.equal((await runChangeDetection({ db: stopped.db, now: () => NOW, env: {}, fetchImpl: (async () => ok("x")) as typeof fetch })).counts.checked, 0);
});
test("a failed due-sources read is a failed run, not an empty one; a failed write is reported on the result", async () => {
  const bad = memoryDb({ system_state: [system] }, { failures: [{ table: "sources", op: "select", message: "down" }] });
  const run = await runChangeDetection({ db: bad.db, now: () => NOW, env: {}, fetchImpl: (async () => ok("x")) as typeof fetch });
  assert.equal(run.outcome, "failed");
  const w = memoryDb({ system_state: [system], sources: [src("a")] }, { failures: [{ table: "monitoring_queue", op: "insert", message: "rls" }] });
  const r2 = await runChangeDetection({ db: w.db, now: () => NOW, env: {}, fetchImpl: (async () => ok(page(prose(40)))) as typeof fetch });
  assert.equal(r2.outcome, "partial", "the source was checked, its write was not");
  assert.ok(r2.notes.some((n) => n.includes("monitoring_queue insert failed: rls")));
});
test("dry selects and counts without fetching or writing", async () => {
  const w = memoryDb({ system_state: [system], sources: [src("a"), src("b")] });
  let calls = 0;
  const run = await runChangeDetection({ db: w.db, now: () => NOW, env: {}, fetchImpl: (async () => (calls++, ok("x"))) as typeof fetch }, { dry: true });
  assert.equal(run.counts.would_check, 2);
  assert.equal(calls, 0);
  assert.equal(w.writes.length, 0);
});
test("the reconcile pass runs in the same run (rule 17) and a failing reconcile degrades the outcome", async () => {
  const w = memoryDb({ system_state: [system], sources: [src("a")] });
  let reconciled = 0;
  const base = { db: w.db, now: () => NOW, env: {}, fetchImpl: (async () => ok(page(prose(40)))) as typeof fetch };
  const good = await runChangeDetection({ ...base, reconcile: async () => (reconciled++, { counts: {}, outcome: "ok" as const, notes: [] }) });
  assert.equal(reconciled, 1);
  assert.equal(good.outcome, "ok");
  const w2 = memoryDb({ system_state: [system], sources: [src("a")] });
  const bad = await runChangeDetection({ ...base, db: w2.db, reconcile: async () => { throw new Error("queue down"); } });
  assert.equal(bad.outcome, "partial");
  assert.ok(bad.notes.some((n) => n.includes("reconcile failed: queue down")));
});
