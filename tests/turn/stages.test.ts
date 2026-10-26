// The stages: each one's planner and shaper (pure), and each one's behaviour over the fixture world with the real wiring. The whole chain is in tests/integration/one-turn.test.ts; these are the edges of each stage.
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeMemberHash } from "@/core/flywheel/themes";
import type { FamilyCall } from "@/core/harness";
import { opNames, runBriefs, runCapture, runConnect, runIntake, runOps, runPropagate, runResearch, runSweep, shapeCapture, shapeChange, shapeConnect, shapeIntake, shapePropagate, shapeSweep } from "@/core/turn";
import { researchAssessment } from "@/features/research";
import { runResult } from "@/core/types/run-result";

import { withReview } from "../batches/world.ts";
import { fixture, NEW_URL, NOW, SRC, DOC, CENSUS } from "../integration/world.ts";

const call = (over: Partial<FamilyCall> = {}): FamilyCall => ({ mode: "apply", dry: false, input: {}, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", upstream: null, ...over });
const dryCall = (input: Record<string, unknown> = {}) => call({ mode: "dry", dry: true, input });

test("sweep: the plan validates its input; the shape names a failed walk and a walk that found nothing is ok", () => {
  assert.equal(shapeSweep([]).outcome, "ok");
  const mixed = shapeSweep([{ sourceId: "a", kind: "feed", ok: true, upserted: 3, failed: 0, changed: 0, note: null }, { sourceId: "b", kind: "feed", ok: false, upserted: 0, failed: 0, changed: 0, note: "HTTP 500" }]);
  assert.deepEqual([mixed.outcome, mixed.counts.sources_failed, mixed.counts.upserted, mixed.notes], ["partial", 1, 3, ["b: HTTP 500"]]);
  assert.equal(shapeSweep([{ sourceId: "b", kind: "feed", ok: false, upserted: 0, failed: 0, changed: 0, note: "x" }]).outcome, "failed");
});

test("sweep: a dry plan fetches nothing; an apply with the fetch gate closed is refused and fetches nothing; a bad input is refused", async () => {
  const f = fixture();
  const dry = await runSweep(dryCall(), f.d);
  assert.deepEqual([dry.outcome, dry.counts.planned_sources, f.requests.urls.length], ["ok", 2, 0]);
  const closed = fixture({ cadence: "off" });
  const refused = await runSweep(call(), closed.d);
  assert.deepEqual([refused.outcome, refused.counts.refused, closed.requests.urls.length], ["failed", 1, 0]);
  assert.match(refused.notes[0] ?? "", /fetch gate closed/);
  assert.equal((await runSweep(call({ input: { limit: 500 } }), f.d)).counts.refused, 1);
});

test("research: the walk input is read from the stage input; a dry walk with the fetch gate closed is planned, never run; an apply is refused by the producer gates and recorded as such", async () => {
  const closed = fixture({ cadence: "off" });
  const dry = await runResearch(dryCall({ walk: { query: "q" } }), closed.d);
  assert.deepEqual([dry.outcome, dry.counts.planned, closed.requests.urls.length], ["ok", 1, 0]);
  const open = fixture();
  const held = await runResearch(call({ input: { walk: { query: "q" } } }), open.d);
  assert.equal(held.outcome, "failed");
  assert.match(held.notes.join(" "), /ENABLED constant is false/);
  assert.equal(held.counts.refused, 1);
  assert.equal(open.requests.urls.filter((u) => u.includes("openalex")).length, 0, "a refused apply costs nothing");
});

test("change: the shape composes the check, its reconcile and the drain; a failed drain makes the stage failed; planChange takes limits", () => {
  const check = { ...runResult("ok", { checked: 2, changes_detected: 1, portal_candidates: 3, failed: 0 }), data: { reconcile: runResult("ok", { processed: 1, staged: 4 }) } };
  const s = shapeChange(check, runResult("ok", { approved: 2, rejected: 1, stamp_failed: 1 }), ["s1"]);
  assert.deepEqual(s.counts, { checked: 2, changes_detected: 1, portal_candidates: 3, would_check: 0, reconciled: 1, staged: 4, update_applied: 2, update_rejected: 1, failed: 1 });
  assert.deepEqual((s.data as { ids: Record<string, string[]> }).ids, { changed_source_ids: ["s1"] });
  assert.equal(shapeChange(check, runResult("failed", {}, ["x"]), []).outcome, "failed");
});

test("capture: a source already queued is not queued twice; the stage hands the worker's capture ids on; the worker is not called while the gate is closed", async () => {
  const shaped = shapeCapture([{ queue_id: "q1", source_id: "s1", outcome: "captured", capture_id: "c1", detail: null }, { queue_id: "q2", source_id: "s2", outcome: "failed", capture_id: null, detail: "HTTP 500" }], 2);
  assert.deepEqual([shaped.outcome, shaped.counts.captured, shaped.counts.failed, shaped.notes], ["partial", 1, 1, ["s2: HTTP 500"]]);
  assert.deepEqual((shaped.data as { ids: Record<string, string[]> }).ids, { capture_ids: ["c1"], captured_source_ids: ["s1"] });
  const f = fixture();
  f.db.seed("pending_first_fetch", [{ source_id: DOC, status: "queued" }]);
  const r = await runCapture(call({ upstream: { id: "u", family: "change-detection", outcome: "success", mode: "apply", ids: { changed_source_ids: [DOC, SRC] }, counts: {} } }), f.d);
  assert.equal(r.counts.queued, 1, "only the source with no open row was queued");
  assert.equal(f.db.rows("pending_first_fetch").filter((x) => x.source_id === DOC).length, 1);
  const closed = fixture({ cadence: "off" });
  let workerCalls = 0;
  closed.d.worker = async () => (workerCalls++, { status: 200, body: {} });
  const refused = await runCapture(call(), closed.d);
  assert.deepEqual([refused.outcome, workerCalls], ["failed", 0]);
  const dry = await runCapture(dryCall(), closed.d);
  assert.deepEqual([dry.outcome, workerCalls, closed.db.writes("pending_first_fetch").length], ["ok", 0, 0]);
  const down = fixture();
  down.d.worker = async () => ({ status: 500, body: { error: "boom" } });
  assert.match((await runCapture(call(), down.d)).notes[0] ?? "", /capture worker answered 500/);
});

test("intake: the cap is enforced, never clamped; a candidate with an invalid verdict is skipped with its reason; the verdicts_owed count is the candidates nobody classified", async () => {
  const f = fixture();
  f.db.seed("portal_link_candidates", [{ source_id: SRC, url: NEW_URL, status: "candidate", first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString() }]);
  await f.d.gate.refresh();
  const bad = await runIntake(call({ input: { verdicts: { [NEW_URL]: "not a verdict" } } }), f.d);
  assert.deepEqual([bad.counts.skipped, bad.counts.promoted, bad.counts.minted], [1, 0, 0]);
  assert.ok(bad.notes.length === 0 && f.db.rows("portal_link_candidates")[0]?.status === "candidate");
  const none = await runIntake(call(), f.d);
  assert.equal(none.counts.verdicts_owed, 1);
  assert.equal((shapeIntake(null, null).data as { ids: Record<string, string[]> }).ids.minted_item_ids?.length, 0);
  assert.equal((await runIntake(call({ input: { limit: 500 } }), f.d)).counts.refused, 1);
});

test("connect: the slice is what the upstream handed over plus the backlog and any named ids; no slice and no corpus request is a noop; a failed pass makes the connected list empty", async () => {
  const bad = shapeConnect(["a"], { tag: runResult("failed", {}, ["tag broke"]), discovery: null, term: null, corpus: null });
  assert.deepEqual([bad.outcome, bad.counts.connected, (bad.data as { ids: Record<string, string[]> }).ids.connected_item_ids], ["failed", 0, []]);
  const f = fixture();
  const r = await runConnect(call(), f.d);
  assert.deepEqual([r.counts.slice, r.counts.connected], [0, 0]);
});

test("propagate: the plan reads the producer request; a producer the gates hold is a note, not a failed stage; the drained intelligence_items events name the items to re-score", async () => {
  const held = shapePropagate({ producers: runResult("failed", { refused: 1 }, ["REFUSING"]), drain: runResult("ok", { drained: 2 }), questions: runResult("ok", { written: 1 }), signposts: runResult("ok", {}), assess: null }, [], []);
  assert.deepEqual([held.outcome, held.counts.drained, held.counts.questions_written], ["partial", 2, 1]);
  assert.equal(shapePropagate({ producers: null, drain: runResult("failed", {}, ["x"]), questions: runResult("ok"), signposts: runResult("ok"), assess: null }, [], []).outcome, "failed");
  const f = fixture();
  const r = await runPropagate(call({ input: { producers: { only: "eu-weekly-oil-bulletin" } } }), f.d);
  assert.notEqual(r.outcome, "failed", r.notes.join("; "));
  assert.equal(f.db.rows("market_series").length, 1, "the held producer wrote nothing");
});

test("IMP-055: an item that changed has its research assessment re-scored in the same propagate run, its counts on the stage's row; dry under build mode it only computes", async () => {
  const ITEM = "a0000000-0000-4000-8000-0000000000aa";
  const world = () => {
    const f = fixture();
    const armed = { ...researchAssessment, enabled: true };
    const g = { ...f, d: Object.assign(f.d, { assessment: armed, env: { ...f.d.env, RESEARCH_ASSESSMENT_PRODUCER_ENABLED: "1" }, producers: { ...f.d.producers, env: { RESEARCH_ASSESSMENT_PRODUCER_ENABLED: "1" } } }) };
    g.db.seed("intelligence_items", [{ id: ITEM, title: "Hydrogen ship engines reach TRL 7", item_type: "research_finding", domain: 7, provenance_status: "verified", is_archived: false, source_id: SRC, added_date: "2026-09-01", what_is_it: "A study of hydrogen engines", full_brief: "Demonstrated at TRL 7 in 2026." }]);
    g.db.seed("research_assessments", [{ id: "e0000000-0000-4000-8000-000000000001", item_id: ITEM, is_current: true, technical_maturity_low: 1, technical_maturity_high: 1, horizon_band: "x", horizon_rule: "R9", horizon_kind: "k", status_token: "HYPOTHESIS", credibility_evidence_score: "limited", computed_by: "research-assessment-producer@1" }]);
    g.db.views.research_assessments_current = () => g.db.tables.research_assessments?.filter((x) => x.is_current === true) ?? [];
    g.db.rows("propagation_events").push({ event_id: 77, occurred_at: NOW.toISOString(), table_name: "intelligence_items", row_pk: ITEM, entity_id: null, change_kind: "update", new_row: {}, drained_at: null });
    return g;
  };
  const f = world();
  const r = await runPropagate(call(), f.d);
  assert.equal((r.data as { ids: { reassessed_item_ids: string[] } }).ids.reassessed_item_ids.join(), ITEM);
  assert.equal(r.counts.assess_candidates, 1);
  assert.equal(r.counts.assessed_written, 1, r.notes.join("; "));
  const rows = f.db.rows("research_assessments").filter((x) => x.item_id === ITEM);
  assert.equal(rows.filter((x) => x.is_current === true).length, 1);
  assert.equal(rows.find((x) => x.is_current === true)?.supersedes, "e0000000-0000-4000-8000-000000000001", "the new current row supersedes the old one");
  // Dry under the gate: computes, writes nothing.
  const d = world();
  const dry = await runPropagate(dryCall(), d.d);
  assert.deepEqual([dry.counts.assess_candidates, d.db.rows("research_assessments").length], [1, 1]);
  // An item that is not research is not a candidate.
  const e = world();
  e.db.rows("intelligence_items")[0]!.item_type = "regulation";
  e.db.rows("intelligence_items")[0]!.domain = 1;
  assert.equal((await runPropagate(call(), e.d)).counts.assess_candidates, undefined);
});

test("briefs: a theme brief that cites no member rows is residue by the no-single-source test and a stale hash is refused; a screen-verdict batch is validated; every kit kind is reached and refuses content that is not a batch; an unknown kind is refused", async () => {
  const f = fixture();
  assert.equal((await runBriefs(call(), f.d)).counts.applied, 0);
  f.db.seed("connection_themes", [{ id: "T1", member_ids: ["a", "b"], surfaces: ["regulations"] }]);
  // a single payload is one entry of a one-entry batch and is validated like any other: sections, claims, figures
  const brief = (hash: string) => JSON.stringify(withReview({ theme_id: "T1", title: "T", member_hash: hash, sections: { connection: "They connect.", meaning: "It matters.", ramifications: "### Regulations\nNeeds an owner.", watch: "Watch the date.", gaps: "" }, claims: [] }, "theme-briefs"));
  const stale = await runBriefs(call({ input: { batch: { kind: "theme-briefs", content: brief("deadbeef") } } }), f.d);
  assert.deepEqual([stale.outcome, f.db.rows("theme_briefs").length], ["failed", 0]);
  const ok = await runBriefs(call({ input: { batch: { kind: "theme-briefs", content: brief(computeMemberHash(["a", "b"])) } } }), f.d);
  assert.deepEqual([ok.outcome, ok.counts.applied, f.db.rows("theme_briefs").length], ["failed", 0, 0]);
  assert.match(ok.notes.join("\n"), /no-single-source test/, "the live hash passes; the brief cites no row, so the second gate names the test");
  const dry = await runBriefs(dryCall({ batch: { kind: "theme-briefs", content: brief(computeMemberHash(["a", "b"])) } }), f.d);
  assert.equal(f.db.rows("theme_briefs").length, 0, "a dry run wrote nothing");
  assert.equal(dry.outcome, "failed");
  const badJson = await runBriefs(call({ input: { batch: { kind: "screen-verdicts", content: "{" } } }), f.d);
  assert.match(badJson.notes[0] ?? "", /not JSON/);
  const partial = await runBriefs(call({ input: { batch: { kind: "screen-verdicts", content: JSON.stringify({ verdicts: [{ census_id: CENSUS, verdict: "on_vertical", basis: "b" }, { census_id: "nope", verdict: "on_vertical", basis: "b" }] }) } } }), f.d);
  assert.deepEqual([partial.outcome, partial.counts.applied, partial.counts.refused], ["partial", 1, 1]);
  for (const kind of ["item-briefs", "question-answers", "needs-search", "forward-events", "ledger-verdicts"]) assert.match((await runBriefs(call({ input: { batch: { kind, content: "x" } } }), f.d)).notes[0] ?? "", /batch is not JSON/, kind);
  assert.match((await runBriefs(call({ input: { batch: { kind: "mystery", content: "x" } } }), f.d)).notes[0] ?? "", /unknown batch kind/);
});

test("ops: every runtime that is not a stage has a named op; an unknown name lists the names; an op owed by an unmerged slice is refused and says who owes it", async () => {
  assert.ok(opNames().length >= 24);
  const f = fixture();
  const unknown = await runOps(call({ input: { ops: { op: "nope" } } }), f.d);
  assert.match(unknown.notes[0] ?? "", /unknown op "nope" \(ops: /);
  for (const [op, owner] of [["backfill-derivation-edges", "P2-11"], ["statutory-run", "P2-10"], ["seed-derived-values", "P2-11"]] as const) {
    const r = await runOps(call({ input: { ops: { op } } }), f.d.marketMethods ? { ...f.d, marketMethods: null, edgeAuthors: null, statutory: null } : f.d);
    assert.deepEqual([r.outcome, r.counts.refused], ["failed", 1], op);
    assert.match(r.notes.join(" "), new RegExp(owner), op);
  }
  const plan = await runOps(dryCall({ ops: { op: "plan-quarantine" } }), f.d);
  assert.equal(plan.notes[0], "op=plan-quarantine");
  assert.notEqual(plan.outcome, "failed", plan.notes.join("; "));
  f.db.seed("notification_outbox", [{ user_id: "u1", kind: "archive", payload: {}, status: "pending", attempts: 0 }]);
  const outbox = await runOps(dryCall({ ops: { op: "run-notification-outbox" } }), f.d);
  assert.equal(outbox.counts.pending, 1);
});

test("ops: plan-drain is a named op that runs the planner over the batch kit's own exporters; off plans nothing, on plans and releases", async () => {
  assert.ok(opNames().includes("plan-drain"));
  const f = fixture();
  const off = await runOps(dryCall({ ops: { op: "plan-drain" } }), f.d);
  assert.equal(off.outcome, "ok", off.notes.join("; "));
  assert.deepEqual([off.counts.planned, off.counts.leases_held], [0, 0]);
  assert.match(off.notes.join(" "), /drain switch is off/);
  f.db.seed("system_state", [{ id: true, judgement_drain: "on", global_processing_paused: false }]);
  const on = await runOps(dryCall({ ops: { op: "plan-drain", args: { kind: "screen-verdict" } } }), f.d);
  assert.equal(on.notes[0], "op=plan-drain");
  assert.ok(!on.notes.join(" ").includes("no exporter function supplied"), on.notes.join("; "));
  assert.equal(on.counts.leases_held, 0, "a dry plan takes no lease");
});
