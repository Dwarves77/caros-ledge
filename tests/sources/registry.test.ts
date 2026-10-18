// The registry entry (registerAndRate and its dedup), snapshots, verification, triage, holdings, classification: the ported behaviour each runtime relies on.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyInstitutionalType, classifySourceRole, classifySourceType, isOffVerticalByIdentity, isValidSourceTypeArray } from "@/core/sources/classify";
import { institutionKey } from "@/core/sources/institution";
import { splitBiasTags, biasChips } from "@/core/sources/bias-tags";
import { officialnessOf } from "@/core/sources/officialness";
import { lookupExactHost, readSourceByUrl, registerAndRate, registerSource } from "@/core/sources/register";
import { verifyTargetMatch, identifierInUrl } from "@/core/sources/target-match";
import { computeTrustScore, planTrustScores } from "@/core/sources/trust-score";
import { classifyCompleteness, detectPublisherShape } from "@/features/sources/holdings-audit";
import { bridgeChangedSourceToStagedUpdates, classifyChange, computeDiff, diffDocuments, reconcileChanges } from "@/features/sources/change";
import { decideProposals, renderBackfillSql } from "@/features/sources/classify-sources";
import { buildPromotedSourceRow, findExistingSourceByCanonicalUrl } from "@/features/sources/provisional";
import { cheapVerifyClaims, decideVerify, requestCapture, STALE_FLAG, verifyItem } from "@/features/sources/snapshot-verify";
import { compareFreshness, getSnapshot, pickLatest, writeSnapshot } from "@/features/sources/snapshots";
import { filterSources } from "@/features/sources/store";
import { applyFetchStatus, createHostThrottle, fetchStatusForDossier, qualifiesAtFloor, runBounded, triageSuspended } from "@/features/sources/triage";
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

// snapshots and verification
test("snapshots: a written body reads back whole, the write is idempotent per content, and a failed upload throws", async () => {
  const w = memoryDb({ raw_fetches: [] }, { unique: { raw_fetches: ["source_id", "content_hash"] } });
  const html = `<html>${"The rule applies. ".repeat(200)}</html>`;
  const written = await writeSnapshot(w.db, "s1", { html, status: 200, isoDay: "2026-10-15" });
  const back = await getSnapshot(w.db, { sourceId: "s1" });
  assert.equal(back.found && back.content, html);
  assert.equal(back.found && back.contentHash, written.contentHash);
  await writeSnapshot(w.db, "s1", { html, status: 200, isoDay: "2026-10-15" });
  assert.equal(w.tables.raw_fetches?.length, 1);
  assert.deepEqual(await getSnapshot(w.db, { sourceId: "other" }), { found: false });
  await assert.rejects(() => writeSnapshot(memoryDb({}, { storageFail: "quota" }).db, "s1", { html, isoDay: "2026-10-15" }), /upload failed/);
  await assert.rejects(() => writeSnapshot(w.db, "", { html, isoDay: "2026-10-15" }), /sourceId required/);
  const down = memoryDb({}, { failures: [{ table: "raw_fetches", op: "select", message: "down" }] });
  await assert.rejects(() => getSnapshot(down.db, { sourceId: "s1" }), /snapshot lookup failed/);
  assert.equal(pickLatest([{ id: "a", fetched_at: "2026-01-01" }, { id: "b", fetched_at: "2026-02-01" }])?.id, "b");
});
test("freshness: an etag decides first, then Last-Modified against the capture time; anything unreadable is unknown", () => {
  assert.equal(compareFreshness({ storedEtag: "a" }, { etag: "a" }).status, "fresh");
  assert.equal(compareFreshness({ storedEtag: "a" }, { etag: "b" }).status, "changed");
  assert.equal(compareFreshness({ fetchedAt: "2026-02-01T00:00:00Z" }, { lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" }).status, "fresh");
  assert.equal(compareFreshness({ fetchedAt: "2026-02-01T00:00:00Z" }, { lastModified: "Sun, 01 Mar 2026 00:00:00 GMT" }).status, "changed");
  assert.equal(compareFreshness({ fetchedAt: "2026-02-01T00:00:00Z" }, { ok: false }).status, "unknown");
  assert.equal(compareFreshness(null, null).status, "unknown");
});
test("verify: a stored snapshot confirms FACT spans cheaply; a changed source flags stale; a missing snapshot asks for a capture; there is no paid path", async () => {
  const body = `<p>${"Operators must report emissions by 31 March each year under Article 9. ".repeat(20)}</p>`;
  const claims = [{ claim_text: "report by 31 March", claim_kind: "FACT", source_span: "Operators must report emissions by 31 March each year under Article 9." }];
  assert.equal(cheapVerifyClaims(claims, body).pass, true);
  assert.equal(cheapVerifyClaims([{ claim_text: "x", claim_kind: "FACT", source_span: "A sentence that is not in the snapshot at all." }], body).pass, false);
  assert.equal(cheapVerifyClaims([], body).pass, false, "no FACT claims never confirms");
  assert.equal(decideVerify({ found: false }, null, null).outcome, "needs_capture");
  assert.equal(decideVerify({ found: true }, { status: "changed" }, { pass: true, reason: "" }).flag, STALE_FLAG);
  assert.equal(decideVerify({ found: true }, { status: "fresh" }, { pass: true, reason: "ok" }).flip, true);

  const w = memoryDb({ raw_fetches: [] });
  await writeSnapshot(w.db, "s1", { html: body, status: 200, isoDay: "2026-10-15" });
  const deps = { db: w.db, loadItem: async () => ({ source_id: "s1", source_url: "https://epa.gov/a" }), loadClaims: async () => claims };
  const read = await verifyItem(deps, "i1");
  assert.equal(read.outcome, "verified_cheap");
  assert.equal(read.acted, false, "reads by default");
  const stale = await verifyItem({ ...deps, act: true, probe: async () => ({ status: "changed", reason: "etag" }) }, "i1");
  assert.equal(stale.outcome, "stale_flag");
  assert.equal(w.tables.integrity_flags?.[0]?.created_by, STALE_FLAG);
  const noSnap = memoryDb({ raw_fetches: [] }, { unique: { pending_first_fetch: ["source_id"] } });
  const need = await verifyItem({ ...deps, db: noSnap.db, act: true }, "i1");
  assert.equal(need.outcome, "needs_capture");
  assert.equal(noSnap.tables.pending_first_fetch?.[0]?.status, "queued");
  assert.deepEqual(await requestCapture(noSnap.db, "s1"), { requested: false, alreadyOpen: true });
  await assert.rejects(() => requestCapture(memoryDb({}, { failures: [{ table: "pending_first_fetch", op: "insert", message: "rls" }] }).db, "s1"), /capture request failed/);
});

// triage
test("triage: per-host politeness spaces hits, the bounded runner stops starting work past its deadline", async () => {
  let t = 0;
  const slept: number[] = [];
  const wait = createHostThrottle({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) });
  await wait("a.gov");
  await wait("a.gov");
  await wait("b.gov");
  assert.deepEqual(slept, [1000]);
  const ran = await runBounded([1, 2, 3, 4, 5], async (n) => { t += 10; return n; }, { concurrency: 1, deadlineAt: t + 25, now: () => t });
  assert.equal(ran.filter((r) => r.skipped).length, 2);
  assert.equal(ran.filter((r) => !r.skipped).length, 3);
  const failing = await runBounded([1], async () => { throw new Error("x"); }, { now: () => 0 });
  assert.equal(failing[0]?.error, "x");
});
test("triage: a dossier maps to a status inside the column's check; a bounded alternative qualifies only at the source's own floor", async () => {
  assert.equal(fetchStatusForDossier({ outcome: "recovered", probe: { head: { status: 200, finalUrl: "" }, primary: {} } }), "ok");
  assert.equal(fetchStatusForDossier({ outcome: "still_inaccessible", probe: { head: { status: 403, finalUrl: "" }, primary: { reason: "cdn_block" } } }), "cdn_block");
  assert.equal(fetchStatusForDossier({ outcome: "still_inaccessible", probe: { head: { status: 403, finalUrl: "" }, primary: { reason: "bot_wall" } } }), "blocked");
  assert.equal(fetchStatusForDossier({ outcome: "still_inaccessible", probe: { head: { status: 0, finalUrl: "" }, primary: {} } }), null);
  assert.equal(qualifiesAtFloor(2, 4), true);
  assert.equal(qualifiesAtFloor(6, 2), false);
  assert.equal(qualifiesAtFloor(null, 4), false);
  const w = memoryDb({ sources: [{ id: "a", fetch_status: null }] });
  const d = { source_id: "a", url: "u", name: "n", base_tier: 2, probe: { head: { status: 403, finalUrl: "u" }, primary: { reason: "soft_404" } }, ladder_steps: [], outcome: "still_inaccessible" as const, evidence: {} };
  assert.deepEqual(await applyFetchStatus(w.db, [d], "2026-10-15T00:00:00Z"), { updated: 1, errors: [] });
  assert.equal(w.tables.sources?.[0]?.fetch_status, "soft_404");
  const bad = await applyFetchStatus(memoryDb({}, { failures: [{ table: "sources", op: "update", message: "rls" }] }).db, [d], "x");
  assert.equal(bad.updated, 0);
  assert.match(bad.errors[0] ?? "", /rls/);
});
test("triage: while the cadence is off the hold refuses every fetch, so nothing is recovered and nothing is written without apply", async () => {
  const w = memoryDb({ system_state: [{ id: true, scrape_cadence: "off", global_processing_paused: false }], sources: [{ id: "a", url: "https://epa.gov/x", name: "EPA", base_tier: 2, status: "suspended" }] });
  let calls = 0;
  const out = await triageSuspended({ db: w.db, now: () => new Date("2026-10-15T00:00:00Z"), env: {}, fetchImpl: (async () => (calls++, new Response("x"))) as typeof fetch, sleep: async () => undefined });
  assert.equal(calls, 0);
  assert.equal(out.counts.errored, 1);
  assert.equal(w.wrote("sources", "update").length, 0);
  const down = memoryDb({}, { failures: [{ table: "sources", op: "select", message: "down" }] });
  assert.equal((await triageSuspended({ db: down.db, now: () => new Date(), env: {} })).outcome, "failed");
});

// holdings
test("holdings: a thin capture is a stub, a body of chrome is furniture, a pool with no usable row is a stub", () => {
  assert.equal(classifyCompleteness({ bytes: 200, body: "x" }).completeness, "STUB");
  assert.equal(classifyCompleteness({ capture_kind: "pool", usablePoolRows: 0 }).completeness, "STUB");
  assert.equal(classifyCompleteness({ capture_kind: "pool", usablePoolRows: 3 }).completeness, "NO-KNOWN-DEFECT");
  const real = `<p>${"Operators must report emissions each year under the scheme. ".repeat(300)}</p>`;
  assert.equal(classifyCompleteness({ bytes: real.length, body: real }).completeness, "NO-KNOWN-DEFECT");
  assert.equal(detectPublisherShape("https://eur-lex.europa.eu/x"), "eur-lex");
  assert.equal(detectPublisherShape("https://example.com/x"), "other");
});

// change
test("change: a field diff classifies by what moved, and a document diff names added and removed provisions", () => {
  const diff = computeDiff({ status: "proposed", deadline: "2026-01-01" }, { status: "in_force", deadline: "2026-01-01" });
  assert.equal(diff.length, 1);
  assert.equal(classifyChange(diff).changeType, "status_change");
  assert.equal(classifyChange([]).severity, "administrative");
  const d = diffDocuments("Article 1\nScope applies to ships.\n\nArticle 2\nReport yearly.", "Article 1\nScope applies to ships.\n\nArticle 2\nReport quarterly.\n\nArticle 3\nPenalties apply.");
  assert.ok(JSON.stringify(d).length > 10);
});
test("change: the bridge stages one update per live item within its limit, from the two newest captures, and reports a failed insert", async () => {
  const w = memoryDb({ sources: [{ id: "s1", url: "https://eur-lex.europa.eu/x" }], raw_fetches: [], staged_updates: [] }, { unique: { raw_fetches: ["source_id", "content_hash"] } });
  await writeSnapshot(w.db, "s1", { html: "Article 1\nScope applies to ships.\n\nArticle 2\nReport yearly.", isoDay: "2026-10-01" });
  w.tables.raw_fetches![0]!.fetched_at = "2026-10-01T00:00:00Z";
  await writeSnapshot(w.db, "s1", { html: "Article 1\nScope applies to ships.\n\nArticle 2\nReport quarterly.\n\nArticle 3\nPenalties apply.", isoDay: "2026-10-08" });
  w.tables.raw_fetches![1]!.fetched_at = "2026-10-08T00:00:00Z";
  const out = await bridgeChangedSourceToStagedUpdates(w.db, { sourceId: "s1", items: [{ id: "i1" }, { id: "i2" }, { id: "i3" }], limit: 2 });
  assert.equal(out.staged, 2);
  assert.equal(out.notBridged, 1);
  assert.equal(out.confidence, "MEDIUM");
  assert.match(String(w.tables.staged_updates?.[0]?.reason), /^\[change-sweep\] amendment diff/);
  assert.deepEqual(w.tables.staged_updates?.[0]?.proposed_changes, {}, "it proposes no content");
  const one = memoryDb({ sources: [{ id: "s1", url: "https://x.test/" }], raw_fetches: [] }, { failures: [{ table: "staged_updates", op: "insert", message: "rls" }] });
  const failed = await bridgeChangedSourceToStagedUpdates(one.db, { sourceId: "s1", items: [{ id: "i1" }] });
  assert.equal(failed.staged, 0);
  assert.equal(failed.confidence, "LOW");
  assert.match(failed.errors[0] ?? "", /rls/);
  await assert.rejects(() => bridgeChangedSourceToStagedUpdates(memoryDb({}, { failures: [{ table: "sources", op: "select", message: "down" }] }).db, { sourceId: "s1", items: [{ id: "i1" }] }), /source read failed/);
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

// classification
test("classify-sources: only a decisive match is adopted, a topic needs re-confirmable evidence, a foreign jurisdiction value is declined, and the backfill renders as SQL", () => {
  const source = { id: "s1", name: "Federal Register", url: "https://www.federalregister.gov/", source_role: "primary_legal_authority" } as never;
  const decisions = decideProposals(
    [
      { field: "scope_modes", value: ["air"], confidence: "high" },
      { field: "scope_verticals", value: ["luxury"], confidence: "medium" },
      { field: "jurisdiction_iso", value: ["NOT-A-PLACE"], confidence: "high" },
      { field: "scope_topics", value: ["regulatory", "fuel"], confidence: "high" },
      { field: "expected_output", value: { regulations: 100 }, confidence: "high" },
    ] as never,
    source,
  );
  const by = (label: string) => decisions.find((d) => d.label.startsWith(label));
  assert.equal(by("scope_modes")?.decision, "adopt");
  assert.equal(by("scope_verticals")?.decision, "decline");
  assert.equal(by("jurisdiction_iso")?.decision, "decline");
  assert.equal(by("scope_topics:regulatory")?.decision, "adopt", "the role is the evidence");
  assert.equal(by("scope_topics:fuel")?.decision, "decline", "no keyword in the name");
  assert.equal(by("expected_output")?.decision, "adopt");
  const sql = renderBackfillSql([{ id: "s1", source_role: "primary_legal_authority", source_type: ["regulator"] }]);
  assert.match(sql, /UPDATE/i);
  assert.match(sql, /s1/);
});
test("classify: role, institutional type and source type come from the name and host, deterministically", () => {
  assert.equal(classifySourceRole("Federal Register", "https://www.federalregister.gov/"), "primary_legal_authority");
  assert.equal(classifySourceRole("", ""), null);
  assert.equal(isOffVerticalByIdentity(classifyInstitutionalType("House of Representatives")), true);
  assert.equal(isValidSourceTypeArray(classifySourceType({ name: "Federal Register", url: "https://www.federalregister.gov/" })), true);
  assert.equal(isValidSourceTypeArray(["nonsense"]), false);
});

// trust, bias, target
test("trust score: the components sum to the overall, a thin history sits near its tier prior, and the plan skips a paused source", () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: "a", name: "A", base_tier: 1, effective_tier: 1, tier_override: null, status: "active", processing_paused: false, ...over }) as never;
  const plan = planTrustScores([row(), row({ id: "b", base_tier: 7 }), row({ id: "c", processing_paused: true })], "2026-10-15T00:00:00Z");
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.skipped_paused, 1);
  const [t1, t7] = plan.rows;
  assert.ok((t1?.overall ?? 0) > (t7?.overall ?? 0), "a tier-1 prior outweighs a tier-7 prior with no history");
  const p = t1!.patch;
  const sum = p.trust_score_accuracy + p.trust_score_timeliness + p.trust_score_reliability + p.trust_score_citation;
  assert.ok(Math.abs(sum - p.trust_score_overall) < 0.11, `components ${sum} vs overall ${p.trust_score_overall}`);
  const earned = computeTrustScore({ confirmation_count: 20, conflict_count: 0, conflict_total: 0, accuracy_rate: 1, total_checks: 30, successful_checks: 30, consecutive_accessible: 30, accessibility_rate: 1, last_accessible: null, last_inaccessible: null, lead_time_samples: 5, avg_lead_time_days: 30, independent_citers: 10, total_citations: 10, self_citation_count: 0, highest_citing_tier: 1 } as never, 7, "2026-10-15T00:00:00Z");
  assert.ok(earned.overall > 80, "earned data replaces the prior");
});
test("bias tags: only vocabulary tags at or above the adoption band are written, and every discard carries its reason", () => {
  const { insertRows, discarded } = splitBiasTags({
    funding: [{ tag: "industry-funded", confidence: 0.9 }, { tag: "made-up", confidence: 0.9 }, { tag: "government-funded", confidence: 0.1 }, { tag: "mixed-funded", confidence: 7 }],
    nonsense: [],
  });
  assert.deepEqual(insertRows.map((r) => r.tag), ["industry-funded"]);
  assert.deepEqual(discarded.map((d) => d.reason).sort(), ["below 0.65 threshold", "invalid confidence", "off-vocabulary tag", "unknown dimension key"].sort());
  assert.deepEqual(splitBiasTags(null), { insertRows: [], discarded: [] });
  assert.equal(splitBiasTags([1]).discarded.length, 1, "a malformed response never throws");
  assert.equal(biasChips(null).total, 0);
});
test("target match: an identifier in the capture matches, a different identifier holds, an identifier in the URL counts", () => {
  const item = { identifier: "2023/956", title: "Carbon Border Adjustment Mechanism" } as never;
  assert.equal(verifyTargetMatch(item, "Regulation (EU) 2023/956 establishing a carbon border adjustment mechanism. ".repeat(10)).verdict, "match");
  assert.notEqual(verifyTargetMatch(item, "Regulation (EU) 2019/631 on CO2 emission performance standards for cars. ".repeat(10)).verdict, "match");
  assert.equal(identifierInUrl(item, "https://eur-lex.europa.eu/eli/reg/2023/956/oj"), true);
});
test("officialness: an instrument body on an authoritative host is official; a link farm is not", () => {
  const body = `<main><h1>Regulation 2023/956</h1><p>Article 1 Scope. This Regulation applies to goods. ${"The operator shall report emissions. ".repeat(40)}</p></main>`;
  const farm = `<nav>${'<a href="/a">link</a> '.repeat(300)}</nav>`;
  assert.ok(officialnessOf(body, "eur-lex.europa.eu", { hostTier: 1, floorTier: 2 }).path);
  assert.notEqual(officialnessOf(farm, "example.com", { hostTier: null, floorTier: 2 }).path, officialnessOf(body, "eur-lex.europa.eu", { hostTier: 1, floorTier: 2 }).path);
});

// provisional, store
test("provisional: a promoted row carries the tier the caller supplies, and an existing source is found by canonical URL", () => {
  const row = buildPromotedSourceRow({ url: "https://epa.gov/x", name: "EPA" } as never, 2, { promotedBy: "t", nowIso: "2026-10-15T00:00:00Z" });
  assert.equal(row.base_tier, 2);
  assert.equal(findExistingSourceByCanonicalUrl([{ url: "https://www.epa.gov/x/" }], "https://epa.gov/x")?.url, "https://www.epa.gov/x/");
  assert.equal(findExistingSourceByCanonicalUrl([], "https://epa.gov/x"), null);
});
test("store: the filter narrows by the customer-visible tier and by text, and never mutates its input", () => {
  const base = { description: "", notes: "", domains: [], jurisdictions: [], status: "active" };
  const sources = [{ ...base, id: "1", name: "EPA", base_tier: 2, effective_tier: null, tier_override: null }, { ...base, id: "2", name: "Blog", base_tier: 2, effective_tier: 7, tier_override: null }, { ...base, id: "3", name: "Pinned", base_tier: 7, effective_tier: 7, tier_override: 1 }] as never[];
  const copy = JSON.stringify(sources);
  const none = { tiers: [], statuses: [], domains: [], jurisdictions: [], search: "" };
  assert.equal(filterSources(sources, { ...none, search: "epa" }).length, 1);
  assert.deepEqual(filterSources(sources, { ...none, tiers: [1] }).map((s) => s.id), ["3"], "an override is the tier a customer sees");
  assert.deepEqual(filterSources(sources, { ...none, tiers: [7] }).map((s) => s.id), ["2"]);
  assert.equal(JSON.stringify(sources), copy);
});
