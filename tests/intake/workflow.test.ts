import assert from "node:assert/strict";
import { test } from "node:test";

import { injectBrief } from "@/features/intake/pipeline";
import { startBriefWorkflow, type InjectedBrief } from "@/features/intake/workflow";

import { CORROB, factClaim, ITEM, OTHER_TEXT, OTHER_URL, makeWorld, marketSignalBody, metadata, NOW, OFFICIAL_URL, poolHashOf, SPAN_FORCE, SPAN_PENALTY, SPAN_REPORT } from "./fixtures.ts";

const injected = (db: ReturnType<typeof makeWorld>["db"], over: Partial<InjectedBrief> = {}): InjectedBrief => ({
  body: marketSignalBody(),
  metadata: metadata(),
  sourcePoolHash: poolHashOf(db),
  ledger: [factClaim(SPAN_REPORT), factClaim(SPAN_PENALTY, { section: "4" }), factClaim(SPAN_FORCE, { section: "3" })],
  ...over,
});
const item = (db: ReturnType<typeof makeWorld>["db"]) => db.rows("intelligence_items").find((r) => r.id === ITEM) as Record<string, unknown>;

test("section 6.2 proof run: a session authors body, metadata and ledger against the stored pool; the workflow accepts, grounds and validates", async () => {
  const { db, deps, rec } = makeWorld();
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  assert.equal(res.status, "verified", JSON.stringify({ steps: res.steps, notes: res.notes }));
  assert.equal(res.outcome, "ok");
  assert.equal(item(db).provenance_status, "verified");
  assert.equal(item(db).item_grade, "brief");
  assert.match(String(item(db).full_brief), /Regulation \(EU\) 2023\/9999/);
  assert.equal(item(db).format_type, "market_signal_brief");
  assert.equal(item(db).severity, "cost_alert");
  assert.equal(item(db).last_regenerated_at, NOW.toISOString());
  const facts = db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT");
  assert.equal(facts.length, 3);
  for (const f of facts) assert.ok(f.search_result_id, "every FACT is attributed to the capture that contains its span");
  assert.ok(db.rows("intelligence_item_sections").length >= 7, "sections were extracted by key");
  assert.ok(db.rows("item_timelines").length >= 2, "the timeline section was harvested");
  // every step writes its own run row (rule 17: the harness record), and the flywheel participation ran in the same run
  const labels = db.rows("agent_runs").map((r) => String(r.fetch_method));
  for (const s of ["preflight", "generate", "register", "section", "ground", "grow", "link", "audit-gate"]) assert.ok(labels.includes(`canonical:${s}`), `run row for ${s}`);
  assert.ok(rec.connects.some((c) => c.startsWith("events:")) && rec.connects.some((c) => c.startsWith("obligations:")), "forward events and obligations ran");
  assert.equal(rec.runs.length, 1, "the recorder got the run's counts");
});

test("ATTACK forged ledger: a FACT whose span is in no capture leaves the item quarantined and is never stored", async () => {
  const { db, deps } = makeWorld();
  const forged = "Operators are exempt from all reporting duties if they hold a valid certificate of sustainable operation.";
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db, { ledger: [factClaim(forged, { claim_text: "Operators are exempt from reporting" })] }) });
  assert.notEqual(res.status, "verified");
  assert.notEqual(item(db).provenance_status, "verified");
  assert.equal(db.rows("section_claim_provenance").filter((c) => String(c.source_span).includes("certificate of sustainable operation")).length, 0, "the forged span never reaches the ledger");
  assert.equal(item(db).full_brief, null, "the ungroundable brief is nulled and the item held (research-or-erase)");
});

test("ATTACK forged ledger mixed with real facts: the forged FACT is dropped, the real ones ground", async () => {
  const { db, deps } = makeWorld();
  const forged = "The penalty for late reporting is waived for the first three years of operation under the Regulation.";
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db, { ledger: [factClaim(SPAN_REPORT), factClaim(forged)] }) });
  assert.equal(res.status, "verified");
  assert.equal(db.rows("section_claim_provenance").filter((c) => String(c.source_span).includes("waived")).length, 0);
});

test("INV-157: injectBrief refuses a stale pool hash and a brief-grade item without allowBriefOverwrite", async () => {
  const { db, deps } = makeWorld();
  const stale = await injectBrief(deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(), sourcePoolHash: "0".repeat(64) });
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /stale pool/);
  assert.equal(item(db).full_brief, null, "nothing was written");
  const w = makeWorld({ briefGrade: true });
  const refused = await injectBrief(w.deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(), sourcePoolHash: poolHashOf(w.db) });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /allowBriefOverwrite/);
  const allowed = await injectBrief(w.deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(), sourcePoolHash: poolHashOf(w.db), allowBriefOverwrite: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  // the pool changes after the author read it: the same hash is now stale
  const changed = makeWorld();
  const hash = poolHashOf(changed.db);
  changed.db.seed("agent_run_searches", [{ intelligence_item_id: ITEM, result_url: "https://eur-lex.europa.eu/other", result_content: "x".repeat(300), result_index: 9 }]);
  assert.equal((await injectBrief(changed.deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(), sourcePoolHash: hash })).ok, false);
});

test("INV-160: injectBrief refuses a body that leaves a required slot silently unaddressed", async () => {
  const { db, deps } = makeWorld();
  db.seed("item_type_required_slots", [{ item_type: "market_signal", slot_key: "tariff_schedule", description: "customs tariff schedule heading classification" }]);
  const r = await injectBrief(deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(), sourcePoolHash: poolHashOf(db) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing_required_slot/);
  const covered = await injectBrief(deps, { itemId: ITEM, body: marketSignalBody({ extra: "[tariff_schedule] GAP: the customs tariff schedule heading classification is not stated in primary sources." }), metadata: metadata(), sourcePoolHash: poolHashOf(db) });
  assert.equal(covered.ok, true, JSON.stringify(covered));
});

test("INV-159: injectBrief refuses metadata that violates the contract and writes nothing", async () => {
  const { db, deps } = makeWorld();
  for (const bad of [{ severity: "CATASTROPHIC" }, { priority: "LOW" }, { topic_tags: ["emissions", "fuels", "transport", "reporting"] }, { signal_band: "bogus" }, { sources_used: ["not-a-uuid"] }]) {
    const r = await injectBrief(deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(bad), sourcePoolHash: poolHashOf(db) });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.detail, /injected_metadata_invalid/);
  }
  assert.equal(item(db).full_brief, null);
  // an out-of-vocabulary compliance object is banked, never dropped silently
  const ok = await injectBrief(deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata({ compliance_object_tags: ["made_up_object"] }), sourcePoolHash: poolHashOf(db) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(JSON.stringify(item(db).compliance_object_candidates).includes("made_up_object"));
});

test("injectBrief dry runs every check and writes nothing", async () => {
  const { db, deps } = makeWorld();
  const r = await injectBrief(deps, { itemId: ITEM, body: marketSignalBody(), metadata: metadata(), sourcePoolHash: poolHashOf(db), dry: true });
  assert.equal(r.ok, true);
  assert.equal(item(db).full_brief, null);
  assert.equal(db.writes("intelligence_items").length, 0);
});

const heldWithClaim = () => {
  const w = makeWorld({ withSource: false });
  w.db.seed("section_claim_provenance", [{ id: "cl-1", intelligence_item_id: ITEM, claim_text: "a grounded claim", claim_kind: "FACT", section_row_id: null, source_span: "a grounded claim", source_id: null, search_result_id: null }]);
  return w;
};

test("the ladder: a source-less item is a structural hold (no re-research), and the erase archives each claim before deleting it", async () => {
  const { db, deps } = makeWorld({ withSource: false });
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  assert.equal(res.status, "structural_held_for_resource");
  assert.ok(db.rows("integrity_flags").some((f) => f.created_by === "source-link-repair"));
  // erase with a claim present: it is archived to claim_versions first (RD-45)
  const w = heldWithClaim();
  const held = await startBriefWorkflow(w.deps, { itemId: ITEM, injected: injected(w.db) });
  assert.equal(held.status, "structural_held_for_resource");
  assert.equal(w.db.rows("section_claim_provenance").length, 0);
  assert.equal(w.db.rows("claim_versions").length, 1, "every erased claim was archived first");
  assert.ok(w.db.rows("claim_versions").every((v) => JSON.stringify(v).includes("proven_inaccurate")));
});

test("erase fails closed: an archive failure stops the erase and leaves the claim in place", async () => {
  const { db, deps } = heldWithClaim();
  db.failWhen = (c) => (c.table === "claim_versions" && c.op === "insert" ? "disk full" : null);
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  assert.ok(res.notes.some((n) => /erase claim cl-1 FAILED/.test(n)) || JSON.stringify(res).includes("erase claim cl-1 FAILED"), "the failed erase is reported");
  assert.equal(db.rows("section_claim_provenance").length, 1, "no claim was deleted without its archive");
});

test("every step's insert error is reported: a failed agent_runs insert is counted, never swallowed", async () => {
  const { db, deps } = makeWorld();
  db.failWhen = (c) => (c.table === "agent_runs" && c.op === "insert" ? "permission denied for agent_runs" : null);
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  assert.ok((res.counts.record_failed ?? 0) >= 8, `record_failed=${res.counts.record_failed}`);
  assert.equal(res.outcome, "partial");
  assert.ok(res.notes.some((n) => n.includes("NOT written")));
});

test("a failed run-ledger row is reported and the cross-item audit gate failure is recorded, not 'recorded: true' after a throw", async () => {
  const { db, deps } = makeWorld();
  deps.recorder.recordRun = async () => ({ error: "ledger down" });
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  assert.ok(res.notes.some((n) => n.includes("run ledger row not written: ledger down")));
});

test("preflight: an open data-audit block without a valid dated waiver halts generation; an unreadable block halts too", async () => {
  const blocked = makeWorld();
  blocked.db.seed("integrity_flags", [{ category: "data_integrity", subject_ref: "data-audit-lane", status: "open", description: "lane red", recommended_actions: [] }]);
  const r = await startBriefWorkflow(blocked.deps, { itemId: ITEM, injected: injected(blocked.db) });
  assert.equal(r.status, "preflight_blocked");
  assert.equal(item(blocked.db).full_brief, null);
  const waived = makeWorld();
  waived.db.seed("integrity_flags", [{ category: "data_integrity", subject_ref: "data-audit-lane", status: "open", description: "lane red", recommended_actions: [{ action: "waiver", until: "2026-12-31" }] }]);
  assert.equal((await startBriefWorkflow(waived.deps, { itemId: ITEM, injected: injected(waived.db) })).status, "verified");
  const unreadable = makeWorld();
  unreadable.db.failWhen = (c) => (c.table === "integrity_flags" && c.op === "select" ? "timeout" : null);
  assert.equal((await startBriefWorkflow(unreadable.deps, { itemId: ITEM, injected: injected(unreadable.db) })).status, "preflight_blocked");
});

test("cross-item audit gate (Layer B): a write that introduces a one-tier-per-host conflict does not stand: the brief is erased, the item quarantined, the specific cause recorded", async () => {
  const { db, deps } = makeWorld();
  const real = deps.sources.registerAndRate;
  // the set_provenance_status trigger: removing the claims re-derives the item's cached status
  db.afterWrite = (c, d) => void (c.table === "section_claim_provenance" && c.op === "delete" && d.rpcs.validate_item_provenance?.({ p_item_id: ITEM }, d));
  let seeded = false;
  deps.sources.registerAndRate = async (url) => {
    if (!seeded) {
      seeded = true;
      db.seed("sources", [{ id: "c0000000-0000-4000-8000-000000000001", name: "duplicate host", url: "https://eur-lex.europa.eu/other", base_tier: 4, tier_override: null, status: "active" }]);
    }
    return real(url);
  };
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  assert.equal(res.status, "audit_gate_failed_quarantined");
  assert.equal(item(db).full_brief, null);
  assert.notEqual(item(db).provenance_status, "verified");
  const flags = db.rows("integrity_flags").filter((f) => f.created_by === "audit-gate");
  assert.equal(flags.length, 1);
  assert.match(String(flags[0]?.description), /one_tier_per_host/);
  assert.equal(db.rows("section_claim_provenance").length, 0, "the erased item's claims no longer count in the corpus tally");
});

test("a rerun with no new injection grounds the stored brief and does not erase it", async () => {
  const { db, deps } = makeWorld();
  await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db) });
  const before = String(item(db).full_brief);
  const again = await startBriefWorkflow(deps, { itemId: ITEM });
  assert.equal(again.status, "verified");
  assert.equal(item(db).full_brief, before);
  const none = makeWorld();
  assert.equal((await startBriefWorkflow(none.deps, { itemId: ITEM })).status, "generate_failed", "no injected brief and no stored brief: an author must supply one");
  assert.equal(OFFICIAL_URL.startsWith("https"), true);
});

test("ENGINE-FIX-2 Q6: a host that is registered but not yet rated keeps its sourceId, so its FACT persists instead of being refused source_resolvable", async () => {
  const { db, deps } = makeWorld();
  deps.sources.resolveSource = () => null;
  deps.sources.registerAndRate = async () => ({ sourceId: CORROB, tier: null });
  const span = OTHER_TEXT.slice(0, 120);
  const res = await startBriefWorkflow(deps, { itemId: ITEM, injected: injected(db, { ledger: [factClaim(span, { source_id: null, source_url: OTHER_URL })] }) });
  assert.match(String(res.steps.ground), /grounded kept=1/, "the FACT persisted (the later audit gate judges the fixture's tier, not this step)");
});
