import assert from "node:assert/strict";
import { test } from "node:test";

import { MINT_OK, applyStagedUpdate, consumePortalCandidates, drainChangeSweepUpdates, isSubstantiveUpdate, persistPortalCandidates, runIntakeCycle, runParticipation, selectCandidateLedgerPage, stageCandidate } from "@/features/intake";
import { applyPromoteCap, buildCandidateSeed } from "@/features/intake/portal-ledger";
import { CHANGE_SWEEP_STAGED_MARKER, UPDATE_ITEM_ALLOWLIST, isRootUrl, splitNewItemSeed } from "@/features/intake/staged-transit";

import { ITEM, OFFICIAL_TEXT, OFFICIAL_URL, SOURCE, SPAN_REPORT, makeWorld } from "./fixtures.ts";

const pending = (over: Record<string, unknown> = {}) => ({ update_type: "update_item", status: "pending", reason: `${CHANGE_SWEEP_STAGED_MARKER} source changed`, item_id: ITEM, proposed_changes: {}, created_at: "2026-10-01T00:00:00Z", ...over });

test("INV-170: a portal root or landing URL is a source, not an item: it never reaches the mint", async () => {
  for (const url of ["https://agency.test", "https://agency.test/", "https://agency.test/en", "https://agency.test/index.html", "https://agency.test/portal"]) assert.equal(isRootUrl(url), true, url);
  for (const url of ["https://agency.test/rules/2026-04", "https://agency.test/en?id=4", "https://agency.test/a/b"]) assert.equal(isRootUrl(url), false, url);
  assert.equal(isRootUrl("not a url"), false);
  const { deps, rec } = makeWorld();
  const r = await applyStagedUpdate(deps, { update_type: "new_item", proposed_changes: { title: "Portal", source_url: "https://agency.test/", item_type: "regulation" } });
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /entity-gate/);
  assert.equal(rec.mints.length, 0, "the mint was never called");
});

test("INV-170: the chokepoint-only inputs (relevance, capturedText, key_deadlines, source_name, authority_level) never reach the seed; relevance travels beside it", async () => {
  const proposed = { title: "T", source_url: "https://agency.test/rules/1", item_type: "regulation", relevance: 12, capturedText: "text", key_deadlines: ["x"], source_name: "S", authority_level: "gov", legacy_id: "L-1" };
  const split = splitNewItemSeed(proposed);
  assert.deepEqual(Object.keys(split.seed).sort(), ["item_type", "legacy_id", "source_url", "title"]);
  assert.equal(split.relevance, 12);
  const { deps, rec } = makeWorld();
  const r = await applyStagedUpdate(deps, { update_type: "new_item", proposed_changes: proposed });
  assert.equal(r.success, true);
  const call = rec.mints[0];
  assert.ok(call);
  for (const k of ["relevance", "capturedText", "key_deadlines", "source_name", "authority_level"]) assert.ok(!(k in call.input.seed), `${k} stripped before the seed`);
  assert.equal(call.input.relevance, 12);
  assert.equal(call.input.legacyId, "L-1");
  assert.equal(call.input.origin, "staged_materialization");
  assert.ok(MINT_OK.includes("minted") && !MINT_OK.includes("rejected"));
  const refused = await applyStagedUpdate(deps, { update_type: "new_item", proposed_changes: { title: "T", source_url: "https://reject-me.test/a/b", item_type: "regulation" } });
  assert.equal(refused.success, false);
  assert.match(refused.error ?? "", /refused by the fixture/);
});

test("proof 4 / B-0059: update_item writes ONLY allowlisted columns; provenance-adjacent columns and an empty patch are refused", async () => {
  const { db, deps } = makeWorld();
  for (const col of ["provenance_status", "item_grade", "full_brief", "source_id", "is_hollow"]) assert.equal(UPDATE_ITEM_ALLOWLIST.has(col), false, `${col} is not allowlisted`);
  const bad = await applyStagedUpdate(deps, { update_type: "update_item", item_id: ITEM, proposed_changes: { title: "New", provenance_status: "verified" } });
  assert.equal(bad.success, false);
  assert.match(bad.error ?? "", /outside the allowlist: provenance_status/);
  assert.equal(db.writes("intelligence_items").length, 0, "nothing was written");
  const empty = await applyStagedUpdate(deps, { update_type: "update_item", item_id: ITEM, proposed_changes: {} });
  assert.equal(empty.success, false);
  assert.match(empty.error ?? "", /empty patch refused/);
  const ok = await applyStagedUpdate(deps, { update_type: "update_item", item_id: ITEM, proposed_changes: { title: "A better title" } });
  assert.equal(ok.success, true);
  assert.equal(db.rows("intelligence_items")[0]?.title, "A better title");
  assert.equal((await applyStagedUpdate(deps, { update_type: "update_item", item_id: null, proposed_changes: { title: "x" } })).success, false);
  assert.equal((await applyStagedUpdate(deps, { update_type: "bogus", proposed_changes: {} })).success, false);
});

test("INV-172: a substantive update reruns the flywheel steps; a bookkeeping-only or empty change runs none; entities re-link only on jurisdiction or key change", async () => {
  assert.equal(isSubstantiveUpdate({ title: "x" }), true);
  assert.equal(isSubstantiveUpdate({ unheard_of_column: 1 }), true, "a deny list: an unknown column counts as substantive");
  assert.equal(isSubstantiveUpdate({ severity: "monitoring", updated_at: "t" }), false);
  assert.equal(isSubstantiveUpdate({}), false);
  assert.equal(isSubstantiveUpdate(null), false);
  const a = makeWorld();
  const sub = await applyStagedUpdate(a.deps, { update_type: "update_item", item_id: ITEM, proposed_changes: { title: "Changed" } });
  assert.deepEqual(a.rec.connects.map((c) => c.split(":")[0]), ["connect", "events", "obligations"], "no entity re-link for a title change");
  assert.ok(sub.flags?.includes("discovery:1"));
  const b = makeWorld();
  await applyStagedUpdate(b.deps, { update_type: "update_item", item_id: ITEM, proposed_changes: { jurisdiction_iso: "GB" } });
  assert.ok(b.rec.connects.some((c) => c.startsWith("entities:")), "a jurisdiction change re-links entities");
  const c = makeWorld();
  await applyStagedUpdate(c.deps, { update_type: "update_item", item_id: ITEM, proposed_changes: { severity: "monitoring" } });
  assert.equal(c.rec.connects.length, 0, "bookkeeping runs no flywheel step");
});

test("proof 3: a mint and a substantive update share ONE step list; a failing step records ONE deduped defect flag and the error is visible; a stale event is flagged and never deleted", async () => {
  const w = makeWorld();
  const mint = await runParticipation({ sb: w.deps.sb, connect: w.deps.connect, now: () => new Date() }, { itemId: ITEM, context: "mint", mint: { title: "Regulation", sourceUrl: OFFICIAL_URL } });
  const mintSteps = w.rec.connects.map((x) => x.split(":")[0]);
  w.rec.connects.length = 0;
  await runParticipation({ sb: w.deps.sb, connect: w.deps.connect, now: () => new Date() }, { itemId: ITEM, context: "update", changed: ["jurisdiction_iso"] });
  const updSteps = w.rec.connects.map((x) => x.split(":")[0]);
  assert.deepEqual(mintSteps, updSteps, "the same step list for a mint and a substantive update");
  assert.equal(mint.outcome, "ok");
  // a failing step: one flag, deduped across reruns
  const f = makeWorld();
  f.deps.connect.connect = async () => {
    throw new Error("graph store unreachable");
  };
  const run = () => runParticipation({ sb: f.deps.sb, connect: f.deps.connect, now: () => new Date() }, { itemId: ITEM, context: "update" });
  const r1 = await run();
  await run();
  assert.equal(r1.outcome, "partial");
  assert.ok(r1.flags.includes("discovery-failed"));
  assert.ok(r1.notes.some((n) => n.includes("graph store unreachable")), "the write error is visible");
  assert.equal(f.db.rows("integrity_flags").filter((x) => x.created_by === "flywheel-defect:discovery").length, 1, "deduped on (item, step)");
  assert.ok(f.rec.connects.some((x) => x.startsWith("events:")), "a failed step does not stop the others");
  // stale events: flagged, never deleted
  const s = makeWorld();
  s.db.seed("item_forward_events", [{ id: "e1", intelligence_item_id: ITEM }]);
  s.deps.connect.extractAndInsertForwardEvents = async () => ({ attempted: 2, inserted: 0, collision: true, staleIds: ["e1"] });
  const r = await runParticipation({ sb: s.deps.sb, connect: s.deps.connect, now: () => new Date() }, { itemId: ITEM, context: "update" });
  assert.ok(r.flags.includes("stale-events:1") && r.flags.includes("forward-events:0"));
  assert.equal(s.db.rows("item_forward_events").length, 1, "the stale event is not deleted");
  assert.equal(s.db.rows("integrity_flags").filter((x) => x.created_by === "flywheel-defect:stale-events").length, 1);
  assert.equal((await runParticipation({ sb: s.deps.sb, connect: s.deps.connect, now: () => new Date() }, { itemId: ITEM, context: "update", dry: true })).notes[0], "dry: no step run");
});

test("proof 3: a failing defect-flag write is itself reported, not swallowed", async () => {
  const w = makeWorld();
  w.deps.connect.deriveObligations = async () => {
    throw new Error("obligation table locked");
  };
  w.db.failWhen = (c) => (c.table === "integrity_flags" && c.op === "insert" ? "flags readonly" : null);
  const r = await runParticipation({ sb: w.deps.sb, connect: w.deps.connect, now: () => new Date() }, { itemId: ITEM, context: "update" });
  assert.ok(r.notes.some((n) => n.includes("not written: flags readonly")));
});

test("INV-015 / rule 17: the intake cycle stages, mints through deps.mint, stamps, and (record-only default) writes the captured text as the item's one pool row", async () => {
  const w = makeWorld();
  const cand = { title: "Reg", source_url: "https://agency.test/rules/9", item_type: "regulation", capturedText: OFFICIAL_TEXT };
  const res = await runIntakeCycle(w.deps, { candidates: [cand] });
  assert.equal(res.outcome, "ok");
  assert.equal(res.items[0]?.disposition, "record_only");
  const staged = w.db.rows("staged_updates")[0];
  assert.equal(staged?.status, "approved", "transit resolved: materialized");
  assert.ok(staged?.materialized_item_id);
  assert.equal((staged?.proposed_changes as Record<string, unknown>).item_grade, "record");
  assert.ok(!("capturedText" in (staged?.proposed_changes as Record<string, unknown>)), "the carrier is never staged");
  const pool = w.db.rows("agent_run_searches").filter((r) => r.intelligence_item_id === staged?.materialized_item_id);
  assert.equal(pool.length, 1);
  assert.equal(pool[0]?.result_content, OFFICIAL_TEXT);
  assert.equal(w.db.rows("agent_runs").length, 0, "no brief workflow ran: record grade only");
  assert.equal(res.counts.minted, 1);
});

test("INV-015: a machine reject stamps the staged row rejected with its reason; a failed stamp is reported and the run is partial", async () => {
  const w = makeWorld();
  const res = await runIntakeCycle(w.deps, { candidates: [{ title: "No", source_url: "https://reject-me.test/a/b", item_type: "regulation" }] });
  assert.equal(res.items[0]?.disposition, "rejected");
  const row = w.db.rows("staged_updates")[0];
  assert.equal(row?.status, "rejected");
  assert.match(String(row?.reviewer_notes), /refused by the fixture/);
  const f = makeWorld();
  f.db.failWhen = (c) => (c.table === "staged_updates" && c.op === "update" ? "row locked" : null);
  const bad = await runIntakeCycle(f.deps, { candidates: [{ title: "T", source_url: "https://agency.test/rules/3", item_type: "regulation" }] });
  assert.equal(bad.outcome, "partial");
  assert.ok(bad.notes.some((n) => n.includes("stamp failed") && n.includes("row locked")));
  const s = makeWorld();
  s.db.failWhen = (c) => (c.table === "staged_updates" && c.op === "insert" ? "no insert" : null);
  const noStage = await runIntakeCycle(s.deps, { candidates: [{ title: "T", source_url: "https://agency.test/rules/4", item_type: "regulation" }] });
  assert.equal(noStage.items[0]?.disposition, "stage_failed");
  assert.equal(s.rec.mints.length, 0, "nothing mints without a staged row");
});

test("plan mode is the real path in dry: the mint is called dry, nothing is staged, nothing is written", async () => {
  const w = makeWorld();
  const res = await runIntakeCycle(w.deps, { mode: "plan", candidates: [{ title: "A", source_url: "https://agency.test/rules/5", item_type: "regulation", capturedText: "x" }, { title: "B", source_url: "https://agency.test/", item_type: "regulation" }] });
  assert.deepEqual(res.items.map((i) => i.disposition), ["would_mint", "would_reject"]);
  assert.ok(w.rec.mints.every((m) => m.dry || false) || w.rec.mints.length === 1);
  assert.equal(w.db.rows("staged_updates").length, 0);
  assert.equal(w.db.writes("intelligence_items").length, 0);
});

test("the cycle: brief grade only through the injected-brief seam; a cycle that seeds a brief runs the workflow, otherwise the item stays a record", async () => {
  const w = makeWorld();
  const res = await runIntakeCycle(w.deps, { recordOnly: false, candidates: [{ title: "Reg", source_url: "https://agency.test/rules/6", item_type: "regulation", capturedText: OFFICIAL_TEXT }] });
  assert.equal(res.items[0]?.disposition, "record_only", "no briefFor: nothing is authored, the item stays a record");
  const x = makeWorld();
  let asked = 0;
  const r2 = await runIntakeCycle(x.deps, { recordOnly: false, candidates: [{ title: "Reg", source_url: "https://agency.test/rules/7", item_type: "regulation" }], briefFor: async () => (asked++, null) });
  assert.equal(asked, 1);
  assert.equal(r2.items[0]?.disposition, "record_only");
});

test("the cycle drains change-sweep updates in the same invocation, even with no candidates (rule 17)", async () => {
  const w = makeWorld();
  w.db.seed("staged_updates", [pending()]);
  const res = await runIntakeCycle(w.deps, { candidates: [] });
  assert.equal(res.counts.drain_drained, 1);
  assert.equal(w.db.rows("staged_updates")[0]?.status, "approved");
});

test("change-sweep drain: only marked rows, an empty patch writes nothing, re-verify is $0, a failed stamp leaves the row pending and is reported, a read failure is a failed drain", async () => {
  const w = makeWorld();
  w.db.seed("staged_updates", [pending(), pending({ reason: "hand staged", item_id: ITEM }), pending({ item_id: null })]);
  const res = await drainChangeSweepUpdates(w.deps, { caller: "t" });
  assert.equal(res.counts.drained, 2, "the unmarked row is untouched");
  assert.equal(w.db.rows("staged_updates").find((r) => r.reason === "hand staged")?.status, "pending");
  assert.deepEqual(w.db.rows("staged_updates").filter((r) => r.status !== "pending").map((r) => r.status).sort(), ["approved", "rejected"]);
  assert.equal(w.db.writes("intelligence_items").length, 0, "an empty patch writes nothing");
  assert.equal(res.items.find((i) => i.disposition === "update_applied")?.reason.startsWith("needs_acquire"), true, "no FACT to verify: held, never fetched");
  // verified_cheap: FACTs verbatim in their captures re-run the validation rpc
  const v = makeWorld();
  const cap = v.db.rows("agent_run_searches")[0];
  v.db.seed("section_claim_provenance", [{ intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: "c", source_span: SPAN_REPORT, search_result_id: cap?.id }]);
  v.db.seed("staged_updates", [pending()]);
  const vr = await drainChangeSweepUpdates(v.deps, { caller: "t" });
  assert.match(vr.items[0]?.reason ?? "", /verified_cheap \(\$0\)/);
  assert.equal(v.db.rows("intelligence_items")[0]?.provenance_status, "verified");
  assert.equal(v.db.rpcCalls.filter((c) => c.name === "validate_item_provenance").length, 1);
  // stamp failure
  const s = makeWorld();
  s.db.seed("staged_updates", [pending()]);
  s.db.failWhen = (c) => (c.table === "staged_updates" && c.op === "update" ? "locked" : null);
  const sr = await drainChangeSweepUpdates(s.deps, { caller: "t" });
  assert.equal(sr.outcome, "partial");
  assert.equal(sr.counts.stamp_failed, 1);
  assert.equal(s.db.rows("staged_updates")[0]?.status, "pending");
  // read failure is a failed drain, never "nothing pending"
  const r = makeWorld();
  r.db.failWhen = (c) => (c.table === "staged_updates" && c.op === "select" ? "timeout" : null);
  assert.equal((await drainChangeSweepUpdates(r.deps, { caller: "t" })).outcome, "failed");
  // bounded: not-drained is reported
  const b = makeWorld();
  b.db.seed("staged_updates", Array.from({ length: 7 }, () => pending()));
  const br = await drainChangeSweepUpdates(b.deps, { caller: "t", limit: 5 });
  assert.equal(br.counts.drained, 5);
  assert.equal(br.notDrained, 1, "the probe read limit+1 rows: at least one more is left pending, and it is reported");
  // dry stamps nothing
  const d = makeWorld();
  d.db.seed("staged_updates", [pending()]);
  await drainChangeSweepUpdates(d.deps, { caller: "t", dry: true });
  assert.equal(d.db.rows("staged_updates")[0]?.status, "pending");
});

test("stageCandidate strips the carrier and stamps record grade on request", async () => {
  const w = makeWorld();
  const r = await stageCandidate(w.deps.sb, { title: "T", source_url: "https://a.test/x", item_type: "regulation", capturedText: "carrier" }, { recordOnly: true });
  assert.ok(r.id);
  const proposed = w.db.rows("staged_updates")[0]?.proposed_changes as Record<string, unknown>;
  assert.ok(!("capturedText" in proposed));
  assert.equal(proposed.item_grade, "record");
});

test("portal ledger: persist is batched and deduped, a failed chunk is reported, the page read is the RPC alone and a failure throws", async () => {
  const w = makeWorld();
  const links = Array.from({ length: 450 }, (_, i) => ({ url: `https://agency.test/d/${i % 400}`, anchorText: `a${i}` }));
  const r = await persistPortalCandidates(w.deps.sb, SOURCE, links, "2026-10-15T00:00:00Z");
  assert.equal(r.upserted, 400);
  assert.equal(r.counts.duplicates, 50);
  assert.equal(w.db.writes("portal_link_candidates").length, 2, "two chunks of up to 200, not one round trip per link");
  const f = makeWorld();
  f.db.failWhen = (c) => (c.table === "portal_link_candidates" && c.op === "upsert" ? "unique violation" : null);
  const fr = await persistPortalCandidates(f.deps.sb, SOURCE, links.slice(0, 5), "t");
  assert.equal(fr.outcome, "failed");
  assert.equal(fr.failed, 5);
  w.db.rpcs.next_uncensused_portal_candidates = () => ({ data: [{ id: "p1", url: "https://agency.test/d/1", anchor_text: null, source_id: SOURCE, first_seen_at: "2026-10-01T00:00:00Z", source_name: "S", source_category: "regulatory", source_base_tier: 1 }] });
  const page = await selectCandidateLedgerPage(w.deps.sb, { limit: 10 });
  assert.equal(page[0]?.sources?.category, "regulatory");
  w.db.rpcs.next_uncensused_portal_candidates = () => ({ error: { message: "rpc down" } });
  await assert.rejects(selectCandidateLedgerPage(w.deps.sb, { limit: 10 }), /lookup failed at next_uncensused_portal_candidates/);
  assert.deepEqual(applyPromoteCap([1, 2, 3], 2), { toPromote: [1, 2], deferred: [3] });
  assert.deepEqual(applyPromoteCap([1, 2], Number.NaN), { toPromote: [1, 2], deferred: [] });
  assert.deepEqual(applyPromoteCap([1, 2], -1), { toPromote: [1, 2], deferred: [] });
});

const verdictFor = (url: string, over: Record<string, unknown> = {}) => ({ entity_verdict: "specific_document", item_type: "regulation", domain: 1, severity: "MONITORING", priority: "LOW", urgency_tier: "stable", title_candidate: `Doc ${url.slice(-2)}`, surface_tags: ["regulations"], relevance: 80, summary: "s", ...over });
const ledgerWorld = (n: number) => {
  const w = makeWorld();
  const rows = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, url: `https://agency.test/rules/${10 + i}`, anchor_text: null, source_id: SOURCE, first_seen_at: `2026-10-0${i + 1}T00:00:00Z`, source_name: "S", source_category: "regulatory", source_base_tier: 1 }));
  w.db.seed("portal_link_candidates", rows.map((r) => ({ id: r.id, url: r.url, status: "candidate", source_id: SOURCE })));
  w.db.rpcs.next_uncensused_portal_candidates = () => ({ data: rows });
  return { ...w, rows };
};

test("portal ledger consume: no verdict means no fetch and no stamp; a not-an-item verdict is rejected; the cap defers the rest untouched; every stamp is checked", async () => {
  const w = ledgerWorld(4);
  const [a, b, c] = w.rows;
  const verdicts = new Map<string, unknown>([[a!.url, verdictFor(a!.url)], [b!.url, verdictFor(b!.url, { entity_verdict: "portal", item_type: null, surface_tags: [] })], [c!.url, verdictFor(c!.url)]]);
  const plan = await consumePortalCandidates(w.deps, { mode: "plan", limit: 10, verdicts });
  assert.deepEqual(plan.outcomes.map((o) => o.disposition), ["would_mint", "not_an_item", "would_mint", "skipped"]);
  assert.equal(w.db.rows("portal_link_candidates").every((r) => r.status === "candidate"), true, "plan is read-only");
  assert.match(plan.outcomes[3]?.reason ?? "", /skipped-no-verdict/);
  const apply = await consumePortalCandidates(w.deps, { mode: "apply", limit: 10, verdicts, maxPromote: 1 });
  const byId = Object.fromEntries(w.db.rows("portal_link_candidates").map((r) => [r.id, r.status]));
  assert.deepEqual([byId.p0, byId.p1, byId.p2, byId.p3], ["promoted", "rejected", "candidate", "candidate"]);
  assert.match(apply.outcomes.find((o) => o.ledgerId === "p2")?.reason ?? "", /capped: max_promote=1/);
  assert.equal(apply.cycle?.counts.minted, 1);
  assert.equal(apply.nextCursor, undefined, "fewer rows than the limit: exhausted");
  const failing = ledgerWorld(1);
  failing.db.failWhen = (q) => (q.table === "portal_link_candidates" && q.op === "update" ? "stamp denied" : null);
  const fr = await consumePortalCandidates(failing.deps, { mode: "apply", limit: 10, verdicts: new Map([[failing.rows[0]!.url, verdictFor(failing.rows[0]!.url, { entity_verdict: "portal", item_type: null, surface_tags: [] })]]) });
  assert.equal(fr.outcome, "partial");
  assert.ok(fr.notes.some((n) => n.includes("stays a candidate")));
  const down = ledgerWorld(1);
  down.db.rpcs.next_uncensused_portal_candidates = () => ({ error: { message: "rpc down" } });
  assert.equal((await consumePortalCandidates(down.deps, { mode: "plan", limit: 5, verdicts: new Map() })).outcome, "failed");
});

test("portal ledger consume: a wall or a short capture leaves the row a candidate; a seed-vocabulary break is skipped loudly; the page cursor advances", async () => {
  const w = ledgerWorld(2);
  w.deps.sources.fetchAllowed = () => true;
  w.deps.sources.capture = async (url) => (url.endsWith("10") ? { ok: true, text: "x".repeat(500), wall: { kind: "captcha" } } : { ok: true, text: "short" });
  const verdicts = new Map(w.rows.map((r) => [r.url, verdictFor(r.url)]));
  const res = await consumePortalCandidates(w.deps, { mode: "plan", limit: 2, verdicts });
  assert.deepEqual(res.outcomes.map((o) => o.disposition), ["skipped", "skipped"]);
  assert.match(res.outcomes[0]?.reason ?? "", /access_wall:captcha/);
  assert.match(res.outcomes[1]?.reason ?? "", /<200ch floor/);
  assert.deepEqual(res.nextCursor, { firstSeenAt: w.rows[1]!.first_seen_at, id: "p1" }, "a skipped row still advances the cursor");
  const seedBreak = ledgerWorld(1);
  const sv = await consumePortalCandidates(seedBreak.deps, { mode: "plan", limit: 5, verdicts: new Map([[seedBreak.rows[0]!.url, verdictFor(seedBreak.rows[0]!.url, { severity: "CATASTROPHIC" })]]) });
  assert.match(sv.outcomes[0]?.reason ?? "", /seed vocabulary/);
  assert.equal(buildCandidateSeed({ id: "x", url: "https://a.test/z", anchor_text: null, source_id: SOURCE, first_seen_at: "t", sources: null }, { entity_verdict: "specific_document", item_type: "regulation", domain: 1, surface_tags: [], relevance: 5, severity: "COST ALERT", priority: "HIGH", urgency_tier: "elevated", topic_tags: [], jurisdictions: [], title_candidate: "T", summary: "", rationale: "" }).severity, "cost_alert");
  assert.ok(ITEM);
});
