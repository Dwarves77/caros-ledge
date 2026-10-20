// The registry entry (registerAndRate and its dedup), snapshots, verification, triage, holdings, classification: the ported behaviour each runtime relies on.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyInstitutionalType, classifySourceRole, classifySourceType, isOffVerticalByIdentity } from "@/core/sources/classify";
import { institutionKey } from "@/core/sources/institution";
import { officialnessOf } from "@/core/sources/officialness";
import { lookupExactHost, readSourceByUrl, registerAndRate, registerSource } from "@/core/sources/register";
import { TIER_WEIGHTS } from "@/core/sources/tier-contract";
import { reconcileChanges } from "@/features/sources/change";
import { renderBackfillSql } from "@/features/sources/classify-sources";
import { detectPublisherShape } from "@/features/sources/holdings-audit";
import { buildPromotedSourceRow, findExistingSourceByCanonicalUrl } from "@/features/sources/provisional";
import { writeSnapshot } from "@/features/sources/snapshots";
import { runBounded, triageSuspended } from "@/features/sources/triage";
import { checkVerticalFitGate } from "@/features/sources/vertical-fit-gate";

import { memoryDb } from "../_support/memory-db.ts";


// register
test("registerAndRate: a class-table host registers at its class tier, and the row's real tier is read back", async () => {
  const w = memoryDb({ sources: [], institutions: [] });
  const r = await registerAndRate(w.db, "https://www.epa.gov/rules", { name: "EPA Rules" });
  assert.equal(r.status, "registered");
  if (r.status === "registered") {
    assert.equal(r.tier, 2);
    assert.ok(r.institution_id);
  }
  assert.equal(w.tables.sources?.[0]?.base_tier, 2);
  assert.equal(w.tables.sources?.[0]?.tier_at_creation, 2);
  const again = await registerAndRate(w.db, "https://www.epa.gov/other");
  assert.equal(again.status, "existing");
  assert.equal(w.tables.sources?.length, 1, "no duplicate row for the same host");
  assert.equal(w.tables.institutions?.length, 1);
});
test("registerAndRate: an unplaceable host is worklisted and an aggregator is refused; neither writes a source", async () => {
  const w = memoryDb({ sources: [] });
  assert.deepEqual(await registerAndRate(w.db, "https://some-unknown-site.example/x"), { status: "worklist", host: "some-unknown-site.example", reason: "the host places in no class-table class and no committed verdict" });
  const refused = await registerAndRate(w.db, "https://law.justia.com/x", { name: "Anything" });
  assert.equal(refused.status, "refused");
  assert.equal((await registerAndRate(w.db, "not a url")).status, "refused");
  assert.equal(w.tables.sources?.length ?? 0, 0);
});
test("IMP-114: every worklist answer is kept on host_worklist by registerAndRate itself, one count per call; a dry call, an aggregator and a placed host keep nothing", async () => {
  const w = memoryDb({ sources: [] });
  const first = await registerAndRate(w.db, "https://some-unknown-site.example/x");
  assert.equal(first.status, "worklist");
  assert.deepEqual(w.tables.host_worklist?.map((r) => [r.host, r.seen_count, r.last_name]), [["some-unknown-site.example", 1, null]]);
  await registerAndRate(w.db, "https://www.some-unknown-site.example/y");
  assert.deepEqual(w.tables.host_worklist?.map((r) => [r.host, r.seen_count, r.last_name]), [["some-unknown-site.example", 2, null]], "a second call (www. and a path do not make a second host) counts once");
  await registerAndRate(w.db, "https://dry-site.example/x", { dry: true });
  await registerAndRate(w.db, "https://law.justia.com/x", { name: "Anything" });
  await registerAndRate(w.db, "https://www.epa.gov/rules");
  assert.deepEqual(w.tables.host_worklist?.map((r) => r.host), ["some-unknown-site.example"], "a dry call, a refused aggregator and a placed host are not worklisted");
});
test("IMP-114: a worklist answer that cannot be kept is the call's failure, never a silent drop", async () => {
  const down = memoryDb({ sources: [] });
  down.mem.rpcs.record_host_worklist = () => ({ error: { message: "write refused" } });
  await assert.rejects(() => registerAndRate(down.db, "https://some-unknown-site.example/x"), /recording some-unknown-site\.example on the host worklist failed: write refused/);
  const absent = memoryDb({ sources: [] });
  absent.mem.rpcs.record_host_worklist = () => ({ error: { message: "function does not exist", code: "PGRST202" } });
  await assert.rejects(() => registerAndRate(absent.db, "https://some-unknown-site.example/x"), /host_worklist is absent \(migration 0064 is not applied\)/);
});
test("registerAndRate: a registry read failure throws, never reads as 'not registered'", async () => {
  const w = memoryDb({ sources: [] }, { failures: [{ table: "sources", op: "select", message: "down" }] });
  await assert.rejects(() => registerAndRate(w.db, "https://www.epa.gov/rules"), /registry lookup failed/);
  assert.equal((await lookupExactHost(w.db, "https://www.epa.gov/")).ok, false);
});
test("registerSource: a tier must come from the table (no default), the institution dedups, a non-active row is reactivated", async () => {
  const w = memoryDb({ sources: [{ id: "s1", url: "https://www.epa.gov/", status: "suspended", base_tier: 2 }] });
  await assert.rejects(() => registerSource(w.db, { url: "https://x.gov/", base_tier: 0 }), /not a tier/);
  await assert.rejects(() => registerSource(w.db, { url: "https://x.gov/", base_tier: undefined as never }), /not a tier/);
  const same = await registerSource(w.db, { url: "https://epa.gov/other", base_tier: 2 });
  assert.deepEqual({ id: same.source_id, created: same.created }, { id: "s1", created: false });
  assert.equal(w.tables.sources?.[0]?.status, "active");
  const fresh = await registerSource(w.db, { url: "https://www.sec.gov/x", base_tier: 2, name: "SEC" });
  assert.equal(fresh.created, true);
  assert.equal((await readSourceByUrl(w.db, "https://www.sec.gov/x"))?.id, fresh.source_id);
  assert.equal(await readSourceByUrl(w.db, "https://nowhere.example/"), null);
});
test("institutionKey: a shared government portal keys by path prefix, a plain host by host", () => {
  assert.equal(institutionKey("https://www.epa.gov/a"), "epa.gov");
  assert.notEqual(institutionKey("https://www.gob.mx/semarnat/x"), institutionKey("https://www.gob.mx/economia/x"));
  assert.equal(institutionKey(""), "");
});

// vertical fit
test("vertical-fit gate: a retired host is refused, an unreadable negative list fails closed unless the operator opted open", async () => {
  const w = memoryDb({ sources: [{ id: "x", url: "https://offtopic.example/a", status: "suspended", notes: "retired off_vertical_suspended" }, { id: "y", url: "https://epa.gov/", status: "active", notes: "" }] });
  assert.equal((await checkVerticalFitGate(w.db, { name: "Off Topic", url: "https://offtopic.example/b" })).allow, false);
  assert.equal((await checkVerticalFitGate(w.db, { name: "EPA", url: "https://epa.gov/b" })).allow, true);
  assert.equal((await checkVerticalFitGate(w.db, { name: "x", url: "" })).allow, true);
  const down = memoryDb({}, { failures: [{ table: "sources", op: "select", message: "down" }] });
  assert.equal((await checkVerticalFitGate(down.db, { name: "EPA", url: "https://epa.gov/b" })).allow, false);
  assert.equal((await checkVerticalFitGate(down.db, { name: "EPA", url: "https://epa.gov/b" }, { failOpen: true })).allow, true);
});

test("triage: while the cadence is off the hold refuses every fetch, so nothing is recovered and nothing is written without apply", async () => {
  const w = memoryDb({ system_state: [{ id: true, scrape_cadence: "off", global_processing_paused: false }], sources: [{ id: "a", url: "https://epa.gov/x", name: "EPA", base_tier: 2, status: "suspended" }] });
  let calls = 0;
  const out = await triageSuspended({ resolveHost: null, db: w.db, now: () => new Date("2026-10-15T00:00:00Z"), env: {}, fetchImpl: (async () => (calls++, new Response("x"))) as typeof fetch, sleep: async () => undefined });
  assert.equal(calls, 0);
  assert.equal(out.counts.errored, 1);
  assert.equal(w.wrote("sources", "update").length, 0);
  const down = memoryDb({}, { failures: [{ table: "sources", op: "select", message: "down" }] });
  assert.equal((await triageSuspended({ resolveHost: null, db: down.db, now: () => new Date(), env: {} })).outcome, "failed");
});

test("change: the reconcile pass records the trigger and stages for live items only, then stamps the queue row; dry writes nothing; a queue read failure fails the pass", async () => {
  const world = () => memoryDb({
    monitoring_queue: [{ id: "q1", source_id: "s1", change_detected: true, reconciled_at: null, checked_at: "2026-10-15T00:00:00Z" }, { id: "q2", source_id: "s1", change_detected: false, reconciled_at: null, checked_at: "2026-10-15T00:00:00Z" }],
    intelligence_items: [{ id: "i1", source_id: "s1", is_archived: false, source_url: "https://x.test/a" }, { id: "i2", source_id: "s1", is_archived: true, source_url: "https://x.test/b" }],
    sources: [{ id: "s1", url: "https://x.test/" }], raw_fetches: [], intelligence_changes: [], staged_updates: [],
  });
  const w = world();
  const out = await reconcileChanges({ db: w.db, now: () => new Date("2026-10-15T12:00:00Z") });
  assert.equal(out.outcome, "ok");
  assert.deepEqual({ processed: out.counts.processed, changes: out.counts.changes_recorded, staged: out.counts.staged }, { processed: 1, changes: 1, staged: 1 });
  assert.equal(w.tables.intelligence_changes?.[0]?.item_id, "i1");
  assert.equal(w.tables.monitoring_queue?.find((r) => r.id === "q1")?.reconciled_at, "2026-10-15T12:00:00.000Z");
  assert.equal(w.tables.monitoring_queue?.find((r) => r.id === "q2")?.reconciled_at, null, "an unchanged row is not consumed");
  const dry = world();
  const projected = await reconcileChanges({ db: dry.db, now: () => new Date() }, { dry: true });
  assert.equal(projected.counts.changes_recorded, 1);
  assert.equal(dry.writes.filter((x) => x.op !== "select").length, 0);
  const down = memoryDb({}, { failures: [{ table: "monitoring_queue", op: "select", message: "down" }] });
  assert.equal((await reconcileChanges({ db: down.db, now: () => new Date() })).outcome, "failed");
});

test("officialness: an instrument body on an authoritative host is official; a link farm is not", () => {
  const body = `<main><h1>Regulation 2023/956</h1><p>Article 1 Scope. This Regulation applies to goods. ${"The operator shall report emissions. ".repeat(40)}</p></main>`;
  const farm = `<nav>${'<a href="/a">link</a> '.repeat(300)}</nav>`;
  assert.ok(officialnessOf(body, "eur-lex.europa.eu", { hostTier: 1, floorTier: 2 }).path);
  assert.notEqual(officialnessOf(farm, "example.com", { hostTier: null, floorTier: 2 }).path, officialnessOf(body, "eur-lex.europa.eu", { hostTier: 1, floorTier: 2 }).path);
});

// provisional
test("provisional: a promoted row carries the tier the caller supplies, and an existing source is found by canonical URL", () => {
  const row = buildPromotedSourceRow({ url: "https://epa.gov/x", name: "EPA" } as never, 2, { promotedBy: "t", nowIso: "2026-10-15T00:00:00Z" });
  assert.equal(row.base_tier, 2);
  assert.equal(findExistingSourceByCanonicalUrl([{ url: "https://www.epa.gov/x/" }], "https://epa.gov/x")?.url, "https://www.epa.gov/x/");
  assert.equal(findExistingSourceByCanonicalUrl([], "https://epa.gov/x"), null);
});

test("snapshots: the write is idempotent per content, and a failed upload or a missing source id throws", async () => {
  const w = memoryDb({ raw_fetches: [] }, { unique: { raw_fetches: ["source_id", "content_hash"] } });
  const html = `<html>${"The rule applies. ".repeat(200)}</html>`;
  const written = await writeSnapshot(w.db, "s1", { html, status: 200, isoDay: "2026-10-15" });
  assert.match(written.contentHash, /^[0-9a-f]+$/);
  await writeSnapshot(w.db, "s1", { html, status: 200, isoDay: "2026-10-15" });
  assert.equal(w.tables.raw_fetches?.length, 1);
  await assert.rejects(() => writeSnapshot(memoryDb({}, { storageFail: "quota" }).db, "s1", { html, isoDay: "2026-10-15" }), /upload failed/);
  await assert.rejects(() => writeSnapshot(w.db, "", { html, isoDay: "2026-10-15" }), /sourceId required/);
});
test("triage: the bounded runner stops starting work past its deadline and reports a throw", async () => {
  let t = 0;
  const ran = await runBounded([1, 2, 3, 4, 5], async (n) => { t += 10; return n; }, { concurrency: 1, deadlineAt: t + 25, now: () => t });
  assert.equal(ran.filter((r) => r.skipped).length, 2);
  assert.equal(ran.filter((r) => !r.skipped).length, 3);
  const failing = await runBounded([1], async () => { throw new Error("x"); }, { now: () => 0 });
  assert.equal(failing[0]?.error, "x");
});
test("holdings: the publisher shape comes from the host", () => {
  assert.equal(detectPublisherShape("https://eur-lex.europa.eu/x"), "eur-lex");
  assert.equal(detectPublisherShape("https://example.com/x"), "other");
});
test("classify: role, institutional type and source type come from the name and host, deterministically", () => {
  assert.equal(classifySourceRole("Federal Register", "https://www.federalregister.gov/"), "primary_legal_authority");
  assert.equal(classifySourceRole("", ""), null);
  assert.equal(isOffVerticalByIdentity(classifyInstitutionalType("House of Representatives")), true);
  assert.deepEqual(classifySourceType({ name: "Federal Register", url: "https://www.federalregister.gov/" }), []);
  assert.deepEqual(classifySourceType({ name: "Environmental Protection Agency", url: "https://www.epa.gov/" }), ["environmental_body"]);
  assert.deepEqual(classifySourceType({ name: "State Senate", url: "https://senate.example.gov/" }), ["legislature"]);
});
test("INV-179: a tier 7 citer weighs zero; a better tier never weighs less than a worse one", () => {
  assert.equal(TIER_WEIGHTS[7], 0);
  for (let tier = 1; tier < 7; tier++) assert.ok((TIER_WEIGHTS[tier] ?? 0) >= (TIER_WEIGHTS[tier + 1] ?? 0), `tier ${tier}`);
});
test("the backfill SQL fills a NULL role or type once and never overwrites a stored value", () => {
  const sql = renderBackfillSql([{ id: "s1", source_role: "primary_legal_authority", source_type: ["regulator"] }, { id: "s2" }]);
  assert.match(sql, /UPDATE public\.sources SET source_role = 'primary_legal_authority' WHERE id = 's1' AND source_role IS NULL;/);
  assert.match(sql, /AND source_type IS NULL;/);
  assert.doesNotMatch(sql, /s2/);
});
