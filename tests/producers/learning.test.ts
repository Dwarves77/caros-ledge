// The learning loop: the signpost matrix (INV-246), trigger questions and questions on change (INV-247), and the judgement drain plan (INV-106, INV-248).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { DRAIN_KINDS, KIND_ORDER, kindForBatchPath, nextBatchPath, resolveKind, screenVerdictExporter, themeClassificationExporter, applyScreenVerdictBatch, finishDrain, leaseDeps, planDrain, selectStaleItems, type DrainDeps, type Exporter } from "@/features/drain";
import { buildEntityItemsReader, describeChange, EMITTING_TABLES, eventTypeForOutboxRow, MAX_ITEMS_PER_EVENT, readOutboxEvents, runQuestionsOnChange, type ChangeDeps } from "@/features/learning/questions-on-change";
import { buildLedgerRows, deadlineMs, matchEventsToSignposts, runSignpostStep, type OutboxEvent, type SignpostRow, type SignpostStepDeps } from "@/features/learning/signpost-scoring";
import { buildSignpostStepDeps, hydrateEventRows } from "@/features/learning/signpost-scoring-deps";
import { generateTriggerQuestions, isTriggerQuestionFlag, PRODUCT_QUESTIONS, questionFlagRow, surfacesForDomain, TRIGGER_EVENT_TYPES, triggerQuestionFlagRow, triggerQuestionsForItem } from "@/features/learning/trigger-questions";
import { classifyTheme } from "@/features/research/theme-rules";

import { memoryDb } from "../_support/memory-db.ts";

import { NOW } from "./support.ts";

// ---- signposts ----
const sp = (id: string, o: Partial<SignpostRow> = {}): SignpostRow => ({ entity_id: id, assessment_id: `a-${id}`, watches: "ent-1", predicate: { op: "date_passed", field: "occurred_at" } as never, direction: "confirms", fired_at: null, ...o });
const evt = (id: number, at: string, o: Partial<OutboxEvent> = {}): OutboxEvent => ({ eventId: String(id), tableName: "market_series", entityId: "ent-1", changeKind: "update", occurredAt: at, ...o });

function fakeStep(state: { watching?: SignpostRow[]; firedUnscored?: SignpostRow[]; deadline?: SignpostRow[]; unapplied?: SignpostRow[]; grounding?: Record<string, string[]>; failFire?: string[]; failScore?: string[]; ledger?: Record<string, string[]> } = {}) {
  const log: string[] = [];
  const ledgerWritten: Array<{ signpost_entity_id: string; source_id: string }> = [];
  const step: SignpostStepDeps = {
    readSignpostsWatching: async () => state.watching ?? [],
    readFiredUnscored: async () => state.firedUnscored ?? [],
    readDeadlineCandidates: async () => state.deadline ?? [],
    readLifecycleUnapplied: async () => state.unapplied ?? [],
    readAssessments: async (ids) => new Map(ids.map((id) => [id, { item_id: `item-${id}`, lifecycle_state: "emerging" }])),
    readGroundingSources: async (items) => new Map(items.map((i) => [i, state.grounding?.[i] ?? []])),
    readLedgerSources: async (id) => state.ledger?.[id] ?? [],
    fire: async (id, _n, reason) => { if (state.failFire?.includes(id)) throw new Error("rpc down"); log.push(`fire:${id}:${reason}`); },
    writeLedger: async (rows) => { log.push(`ledger:${rows.length}`); ledgerWritten.push(...rows); },
    scoreSignpost: async (id, patch) => { if (state.failScore?.includes(id)) throw new Error("score failed"); log.push(`score:${id}:${patch.outcome}`); },
  };
  return { step, log, ledgerWritten };
}
const run = (f: ReturnType<typeof fakeStep>, input: Parameters<typeof runSignpostStep>[1]) => runSignpostStep({ step: f.step, now: () => NOW }, input);

test("INV-246 matrix: the first qualifying event fires a signpost once; a signposts-table event never fires; a late event is counted and does not fire; an unmatched entity does nothing", async () => {
  const f = fakeStep({ watching: [sp("s1"), sp("s2", { predicate: { op: "date_passed", field: "occurred_at", by: "2026-10-10" } as never })] });
  const r = await run(f, { dry: false, sweep: false, events: [evt(1, "2026-10-12T00:00:00Z", { tableName: "signposts" }), evt(3, "2026-10-14T00:00:00Z"), evt(2, "2026-10-13T00:00:00Z"), evt(4, "2026-10-14T01:00:00Z", { entityId: null }), evt(5, "2026-10-15T00:00:00Z", { entityId: "other" })] });
  assert.equal(r.counts.events_signpost_origin, 1);
  assert.equal(r.counts.events_no_entity, 1);
  assert.equal(r.counts.events_late, 2, "s2's deadline (end of 2026-10-10) is before both events");
  assert.equal(r.counts.signposts_fired, 1);
  assert.deepEqual(f.log.filter((l) => l.startsWith("fire")).map((l) => l.split(":")[1]), ["s1"], "fired once, on the FIRST event in occurrence order, not the first in the array");
  assert.equal(r.counts.scored_held, 1);
  const m = matchEventsToSignposts([evt(2, "2026-10-13T00:00:00Z"), evt(1, "2026-10-12T00:00:00Z")], [sp("s1")], NOW);
  assert.equal(m.fires[0]?.event.eventId, "1");
  assert.equal(deadlineMs({ by: "2026-10-10" }), Date.parse("2026-10-10") + 86_400_000);
  assert.equal(deadlineMs({}), null);
});

test("INV-246: the outcome is the direction map (confirms held, refutes refuted, delays partial); a passed deadline with no firing scores refuted; repair scores a fired-unscored signpost", async () => {
  const f = fakeStep({
    watching: [sp("c"), sp("r", { direction: "refutes" }), sp("d", { direction: "delays" })],
    firedUnscored: [sp("repair", { fired_at: "2026-10-01T00:00:00Z", direction: "delays" })],
    deadline: [sp("late", { watching: undefined, predicate: { op: "date_passed", field: "occurred_at", by: "2026-10-01" } as never }), sp("future", { predicate: { op: "date_passed", field: "occurred_at", by: "2027-01-01" } as never })],
  } as never);
  const r = await run(f, { dry: false, events: [evt(1, "2026-10-12T00:00:00Z")] });
  const scores = Object.fromEntries(f.log.filter((l) => l.startsWith("score")).map((l) => l.split(":").slice(1)));
  assert.deepEqual(scores, { c: "held", r: "refuted", d: "partial", repair: "partial", late: "refuted" });
  assert.deepEqual([r.counts.scored_by_event, r.counts.scored_by_repair, r.counts.scored_by_deadline], [3, 1, 1]);
  assert.equal(scores.future, undefined);
});

test("INV-246: scoring writes one ledger row per DISTINCT grounding source BEFORE the score and never twice; a source-less score is counted; a score or fire failure is counted with its event id and never aborts the pass", async () => {
  assert.equal(buildLedgerRows({ signpostEntityId: "s", assessmentId: "a", outcome: "held", sourceIds: ["x", "y", "x", ""], now: NOW }).length, 2);
  const f = fakeStep({ watching: [sp("s1"), sp("s2"), sp("s3", { watches: "ent-2" })], grounding: { "item-a-s1": ["x", "y", "x"], "item-a-s3": ["z"] }, ledger: { s1: ["y"] }, failFire: ["s3"], failScore: ["s2"] });
  const r = await run(f, { dry: false, sweep: false, events: [evt(1, "2026-10-12T00:00:00Z"), evt(2, "2026-10-12T00:00:00Z", { entityId: "ent-2" })] });
  assert.ok(f.log.indexOf("ledger:1") < f.log.indexOf("score:s1:held"), "ledger first, then the score");
  assert.deepEqual(f.ledgerWritten.map((l) => l.source_id), ["x"], "y already had a row");
  assert.equal(r.counts.ledger_rows_existing, 1);
  assert.equal(r.counts.scored_without_sources, 1, "s2 had no grounding");
  assert.equal(r.counts.errors, 2);
  assert.deepEqual([...r.failedEventIds].sort(), ["1", "2"], "the failed score and the failed fire keep their event ids for replay");
  assert.equal(r.outcome, "partial");
});

test("INV-246: a dry pass counts everything and writes nothing; a fired signpost whose lifecycle was never applied is repaired by firing again (idempotent on the stamp)", async () => {
  const f = fakeStep({ watching: [sp("s1")], unapplied: [sp("old", { fired_at: "2026-09-01T00:00:00Z" })] });
  const dry = await run(f, { events: [evt(1, "2026-10-12T00:00:00Z")] });
  assert.deepEqual(f.log, []);
  assert.deepEqual([dry.counts.signposts_fired, dry.counts.lifecycle_repair_planned, dry.counts.lifecycle_repaired], [1, 1, 0]);
  const live = fakeStep({ unapplied: [sp("old", { fired_at: "2026-09-01T00:00:00Z" })] });
  const r = await run(live, { dry: false, events: [] });
  assert.equal(r.counts.lifecycle_repaired, 1);
  assert.match(live.log[0] as string, /fire:old:lifecycle repair/);
});

test("the real signpost deps: firing is the one transactional rpc, scoring writes the ledger then the score, reads throw on error and never read as an empty list", async () => {
  const fired: unknown[] = [];
  const db = memoryDb(
    { signposts: [{ entity_id: "s1", assessment_id: "a1", watches: "ent-1", predicate: { op: "date_passed", field: "occurred_at" }, direction: "confirms", fired_at: null, outcome: null }], research_assessments: [{ id: "a1", item_id: "i1", lifecycle_state: "emerging" }], section_claim_provenance: [{ intelligence_item_id: "i1", source_id: "src-1", claim_kind: "FACT" }, { intelligence_item_id: "i1", source_id: "src-2", claim_kind: "ANALYSIS" }] },
    { rpc: (n, a) => (n === "fire_signpost" ? (fired.push(a), { data: { fired: true, first_firing: true, signpost_entity_id: "s1", previous_lifecycle_state: "emerging", new_lifecycle_state: "strengthening" } }) : {}) },
  );
  const r = await runSignpostStep({ step: buildSignpostStepDeps(db.db), now: () => NOW }, { dry: false, sweep: false, events: [evt(1, "2026-10-12T00:00:00Z", { newRow: { occurred_at: "2026-10-12T00:00:00Z" } })] });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(fired.length, 1);
  assert.deepEqual(db.tables.source_reliability_ledger?.map((l) => l.source_id), ["src-1"], "only FACT/LEGAL grounding counts");
  assert.equal(db.tables.signposts?.[0]?.outcome, "held");
  const broken = memoryDb({}, { failures: [{ table: "signposts", op: "select", message: "down" }] });
  await assert.rejects(() => buildSignpostStepDeps(broken.db).readFiredUnscored(), /paginated read failed/);
  const hydrated = await hydrateEventRows(memoryDb({ propagation_events: [{ event_id: "7", new_row: { a: 1 } }] }).db, [{ ...evt(7, "2026-10-12T00:00:00Z") }]);
  assert.deepEqual(hydrated[0]?.newRow, { a: 1 });
});

// ---- trigger questions ----
test("INV-247: four questions per routed surface, none for domain 5 or null, the flag row is an open coverage gap under the question: namespace answered from holdings, never a fetch", () => {
  assert.deepEqual(PRODUCT_QUESTIONS, ["what", "affects_me", "comply", "invest_wait_avoid"]);
  assert.equal(TRIGGER_EVENT_TYPES.length, 7);
  assert.deepEqual([surfacesForDomain(1), surfacesForDomain(2), surfacesForDomain(3), surfacesForDomain(4), surfacesForDomain(6), surfacesForDomain(7), surfacesForDomain(5), surfacesForDomain(null)], [["regulations"], ["market_intel"], ["operations"], ["market_intel"], ["operations"], ["research"], [], []]);
  const qs = generateTriggerQuestions({ id: "i1", title: "A rule", domain: 1 }, { eventType: "value_revised", eventId: 9, change: "a value was revised" });
  assert.equal(qs.length, 4);
  assert.deepEqual(qs.map((q) => q.subjectRef), PRODUCT_QUESTIONS.map((p) => `i1:regulations:${p}`));
  assert.ok(qs.every((q) => q.createdBy.startsWith("question:") && q.questionText.includes("a value was revised")));
  assert.deepEqual(generateTriggerQuestions({ id: "i2", domain: 5 }), []);
  assert.deepEqual(generateTriggerQuestions({ id: "i2", domain: null }), []);
  assert.deepEqual(generateTriggerQuestions(null), []);
  const row = triggerQuestionFlagRow(qs[0]!);
  assert.deepEqual([row.category, row.subject_type, row.status, row.created_by], ["coverage_gap", "item", "open", "question:what"]);
  assert.match(JSON.stringify(row.recommended_actions), /answered from holdings by a session batch.*never a fetch or a priced request/);
  assert.equal(row.description.length <= 480, true);
  assert.equal(isTriggerQuestionFlag("question:what"), true);
  assert.equal(isTriggerQuestionFlag("flywheel-gap:x"), false);
  assert.equal(questionFlagRow({ id: "i1", title: "A rule", domain: 1 }, "i1:regulations:comply")?.created_by, "question:comply");
  assert.equal(questionFlagRow({ id: "i1", domain: 5 }, "i1:regulations:comply"), null);
});

test("INV-247: the writer dedups within the batch and against OPEN flags on (subject_ref, created_by); dry writes nothing; a failed read or insert fails the run", async () => {
  const db = memoryDb({ integrity_flags: [{ id: 1, subject_ref: "i1:regulations:what", created_by: "question:what", status: "open" }, { id: 2, subject_ref: "i1:regulations:comply", created_by: "question:comply", status: "resolved" }] });
  const deps = { sb: db.db, now: () => NOW };
  const items = [{ id: "i1", title: "T", domain: 1 }, { id: "i1", title: "T", domain: 1 }];
  const dry = await triggerQuestionsForItem(deps, { items });
  assert.deepEqual([dry.counts.questions_generated, dry.counts.deduped_in_batch, dry.counts.already_open, dry.counts.new, dry.counts.written], [8, 4, 1, 3, 0]);
  assert.equal(db.writes.filter((w) => w.op === "insert").length, 0);
  const live = await triggerQuestionsForItem(deps, { items, dry: false });
  assert.equal(live.counts.written, 3, "a resolved flag does not block a new question; an open one does");
  assert.equal((await triggerQuestionsForItem(deps, { items, dry: false })).counts.written, 0);
  const none = await triggerQuestionsForItem(deps, { items: [{ id: "x", domain: 5 }] });
  assert.match(none.notes[0] as string, /0 questions generated/);
  const failRead = await triggerQuestionsForItem({ sb: memoryDb({}, { failures: [{ table: "integrity_flags", op: "select", message: "down" }] }).db, now: () => NOW }, { items, dry: false });
  assert.equal(failRead.outcome, "failed");
  const failWrite = await triggerQuestionsForItem({ sb: memoryDb({}, { failures: [{ table: "integrity_flags", op: "insert", message: "rls" }] }).db, now: () => NOW }, { items, dry: false });
  assert.equal(failWrite.outcome, "failed");
});

// ---- questions on change ----
const items = (n: number, over: object = {}) => Array.from({ length: n }, (_, i) => ({ id: `item-${String(i).padStart(3, "0")}`, title: `Item ${i}`, domain: 1, provenance_status: "verified", is_archived: false, ...over }));
const changeDeps = (db: ReturnType<typeof memoryDb>, links: Record<string, { entityName: string | null; items: ReturnType<typeof items> }>, failFor: string[] = []): ChangeDeps => ({ sb: db.db, now: () => NOW, readEntityLinks: async (id) => { if (failFor.includes(id)) throw new Error("links read failed"); return links[id] ?? { entityName: null, items: [] }; } });

test("INV-247: at most 25 items per change event, verified and non-archived only, ordered by id; the cap is counted; an unregistered table and an event with no entity are counted", async () => {
  const db = memoryDb({});
  const deps = changeDeps(db, { e1: { entityName: "Series X", items: [...items(30), ...items(2, { provenance_status: "unverified", id: "u" }), ...items(1, { is_archived: true, id: "a" })] } });
  const r = await runQuestionsOnChange(deps, { events: [{ eventId: 1, tableName: "market_series", rowPk: "p", entityId: "e1", changeKind: "update" }, { eventId: 2, tableName: "unregistered_table", entityId: "e1" }, { eventId: 3, tableName: "market_series", entityId: null }] });
  assert.deepEqual([r.counts.events_mapped, r.counts.events_unmapped, r.counts.events_no_entity, r.counts.items_affected, r.counts.items_dropped_by_cap, r.counts.questions_generated], [1, 1, 1, 25, 5, 100]);
  assert.equal(MAX_ITEMS_PER_EVENT, 25);
  const live = await runQuestionsOnChange(changeDeps(memoryDb({}), { e1: { entityName: "Series X", items: items(3) } }), { dry: false, events: [{ eventId: 1, tableName: "signposts", rowPk: "p", entityId: "e1", changeKind: "update" }] });
  assert.equal(live.counts.written, 12);
  assert.match(describeChange({ eventId: 1, tableName: "market_series", rowPk: "p1", entityId: "e1", changeKind: "supersede" }, "Series X"), /a market series value \(p1\) was superseded on Series X \(e1\)/);
  assert.match(describeChange({ eventId: 1, tableName: "entity_aliases", rowPk: "p", entityId: "e1" }, null), /the identity of e1 changed/);
  assert.equal(eventTypeForOutboxRow({ table_name: "emission_factors", change_kind: "supersede" }), "factor_superseded");
  assert.equal(eventTypeForOutboxRow({ table_name: "emission_factors", change_kind: "update" }), "value_revised");
  assert.equal(eventTypeForOutboxRow({ table_name: "nope" }), null);
});

test("INV-247: a failed entity read is counted WITH its error text and the event id is kept for replay (B-0271), the other events still raise their questions, and the outbox replay reads by ids or by range", async () => {
  const db = memoryDb({});
  const r = await runQuestionsOnChange(changeDeps(db, { ok: { entityName: null, items: items(1) } }, ["bad"]), { events: [{ eventId: 11, tableName: "market_series", entityId: "bad" }, { eventId: 12, tableName: "market_series", entityId: "ok" }] });
  assert.equal(r.counts.read_errors, 1);
  assert.deepEqual(r.failedEventIds, [11]);
  assert.match(r.notes.join("|"), /event 11: reading links of bad failed: links read failed/);
  assert.equal(r.counts.questions_generated, 4);
  assert.equal(r.outcome, "partial");
  const out = memoryDb({ propagation_events: [{ event_id: "5", table_name: "market_series", row_pk: "a", entity_id: "e", change_kind: "update", occurred_at: "2026-10-01" }, { event_id: "3", table_name: "signposts", row_pk: "b", entity_id: "f", change_kind: "update", occurred_at: "2026-10-02" }, { event_id: "9", table_name: "x", row_pk: "c", entity_id: null, change_kind: null, occurred_at: "2026-10-03" }] });
  assert.deepEqual((await readOutboxEvents(out.db, { ids: [5, 3] })).map((e) => e.eventId), ["3", "5"]);
  assert.deepEqual((await readOutboxEvents(out.db, { from: 4, to: 9 })).map((e) => e.eventId), ["5", "9"]);
  const reader = buildEntityItemsReader(memoryDb({ entities: [{ entity_id: "e1", canonical_name: "Series X" }], intelligence_items: [{ id: "i1", instrument_entity_id: "e1", provenance_status: "verified", title: "T", domain: 1 }, { id: "i2", provenance_status: "verified", title: "T2", domain: 1 }, { id: "i3", provenance_status: "unverified", instrument_entity_id: "e1", title: "T3", domain: 1 }], entity_refs: [{ ref_table: "intelligence_items", ref_id: "i2", entity_id: "e1", role: "mentions" }] }).db);
  const links = await reader("e1");
  assert.equal(links.entityName, "Series X");
  assert.deepEqual(links.items.map((i) => i.id).sort(), ["i1", "i2"]);
});

test("QOC-1: the emitting-table registry equals the directory (a new emitting table adds a file AND its registry line), every entry is valid and names a trigger event type", () => {
  const files = readdirSync(new URL("../../src/features/learning/data/emitting-tables/", import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(Object.keys(EMITTING_TABLES).sort(), files);
  for (const e of Object.values(EMITTING_TABLES)) assert.ok((TRIGGER_EVENT_TYPES as readonly string[]).includes(e.type), e.table_name);
});

// ---- the judgement drain ----
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function drainDeps(o: { on?: boolean; exporters?: Record<string, Exporter>; held?: Record<string, string>; existing?: Record<string, string[]> } = {}) {
  const calls: string[] = [];
  const leased: string[] = [];
  const released: string[] = [];
  const deps: DrainDeps = {
    readSwitch: async () => { calls.push("switch"); return { on: o.on !== false, reason: o.on === false ? "judgement_drain is off" : null, judgementDrain: o.on === false ? "off" : "on", emergencyPaused: false, fleetHalted: false, readFailed: false }; },
    exporters: o.exporters ?? {},
    listBatchDir: (k) => { calls.push(`list:${k.id}`); return o.existing?.[k.id] ?? []; },
    acquire: async (id, holder) => { calls.push(`acquire:${id}`); if (o.held?.[id]) return { acquired: false, cur_holder: o.held[id] as string }; leased.push(id); return { acquired: true, cur_holder: holder }; },
    release: async (id) => { released.push(id); return true; },
    now: () => NOW,
  };
  return { deps, calls, leased, released };
}
const ex = (items: Array<Record<string, unknown>>, extra: object = {}): Exporter => async () => ({ ok: true, items, ...extra });

test("INV-106: with the switch off the plan is empty and NOTHING else is read (no export, no lease, no directory listing)", async () => {
  const d = drainDeps({ on: false, exporters: Object.fromEntries(DRAIN_KINDS.map((k) => [k.id, async () => { throw new Error("must not export"); }])) });
  const plan = await planDrain(d.deps, { runId: "r1" });
  assert.equal(plan.drain, "off");
  assert.deepEqual(d.calls, ["switch"]);
  assert.deepEqual([plan.kinds.length, plan.leases.length, plan.totals.items], [0, 0, 0]);
});

test("INV-248: every planned item is leased once per uuid by the run holder; a non-uuid key and an item leased by another holder are NAMED residue; batches number from the committed directory; a dry plan takes no lease", async () => {
  const items = [{ id: U(1), title: "a" }, { id: U(1), title: "dup uuid" }, { id: "not-a-uuid" }, { id: U(2) }, { id: U(3) }];
  const d = drainDeps({ exporters: { "record-briefs": ex(items) }, held: { [U(3)]: "drain-other" }, existing: { "record-briefs": ["record-briefs-001.json", "record-briefs-007a.json", "README.md"] } });
  const plan = await planDrain(d.deps, { runId: "r2", kindId: "record-briefs" });
  const k = plan.kinds[0]!;
  assert.deepEqual(d.leased, [U(1), U(2)], "one lease per uuid even when two items share it");
  assert.equal(plan.leases.every((l) => l.holder === "drain-r2"), true);
  assert.deepEqual(k.residue.lease_held.map((r) => [r.id, r.holder, r.reason]), [["not-a-uuid", null, "lease key is not a uuid"], [U(3), "drain-other", "leased by another session"]]);
  assert.equal(k.batches[0]?.batch_path, "drain/batches/record-briefs/record-briefs-008.json");
  assert.deepEqual(k.batches[0]?.item_ids, [U(1), U(1), U(2)]);
  const dry = drainDeps({ exporters: { "record-briefs": ex(items) } });
  const dp = await planDrain(dry.deps, { runId: "r3", kindId: "record-briefs", dry: true });
  assert.equal(dry.leased.length, 0);
  assert.equal(dp.dry, true);
  assert.equal(dp.kinds[0]?.would_lease, 3, "a dry plan cannot know the holders, so it counts the distinct uuids it would try");
  assert.equal(nextBatchPath(DRAIN_KINDS[0]!, ["ledger-verdicts-001.json", "ledger-verdicts-002.json"], 1), "drain/batches/ledger-verdicts/ledger-verdicts-004.json");
});

test("INV-248: a stale plan lists only items under another prompt_version and REFUSES without a live prompt_version; a mode needs its kind; a kind caps at its batch size and names the over-cap residue", async () => {
  const stale = [{ candidate_id: U(1), verdict_prompt_version: "v1", first_seen_at: "2026-09-01" }, { candidate_id: U(2), verdict_prompt_version: "v2", first_seen_at: "2026-08-01" }, { candidate_id: U(3), verdict_prompt_version: "v1", first_seen_at: "2026-07-01" }];
  assert.deepEqual(selectStaleItems(stale, "v2").map((i) => i.candidate_id), [U(3), U(1)]);
  const live = drainDeps({ exporters: { "ledger-verdicts": ex(stale, { current_prompt_version: "v2" }) } });
  const p = await planDrain(live.deps, { runId: "r4", kindId: "ledger-verdicts", mode: "stale" });
  assert.deepEqual([p.kinds[0]?.batches[0]?.item_ids, p.kinds[0]?.residue.not_stale], [[U(3), U(1)], 1]);
  const noVersion = drainDeps({ exporters: { "ledger-verdicts": ex(stale) } });
  const refused = await planDrain(noVersion.deps, { runId: "r5", kindId: "ledger-verdicts", mode: "stale" });
  assert.match(refused.kinds[0]?.export_error ?? "", /live prompt_version/);
  assert.equal(refused.kinds[0]?.batches.length, 0);
  assert.equal(noVersion.leased.length, 0);
  await assert.rejects(() => planDrain(live.deps, { runId: "r", mode: "stale" }), /requires a kind/);
  await assert.rejects(() => planDrain(live.deps, { runId: "r", kindId: "host-verdicts", mode: "stale" }), /no mode "stale"/);
  await assert.rejects(() => planDrain(live.deps, { runId: "r", kindId: "nope" }), /unknown kind/);
  const many = Array.from({ length: 200 }, (_, i) => ({ host: `h${i}.example` }));
  const capped = await planDrain(drainDeps({ exporters: { "host-verdicts": ex(many) } }).deps, { runId: "r6", kindId: "host-verdicts" });
  assert.deepEqual([capped.kinds[0]?.batches[0]?.count, capped.kinds[0]?.residue.over_cap], [150, 50]);
});

test("a kind whose exporter fails or is absent is a named export error, not an empty queue; kinds plan oldest-pending first", async () => {
  const d = drainDeps({ exporters: { "needs-search": async () => ({ ok: false, items: [], error: "db down" }), "question-answers": ex([{ subject_ref: "s", item_id: U(1), created_at: "2026-09-01" }]), "theme-briefs": ex([{ theme_id: U(2), created_at: "2026-08-01" }]) } });
  const p = await planDrain(d.deps, { runId: "r7" });
  const by = Object.fromEntries(p.kinds.map((k) => [k.kind, k]));
  assert.equal(by["needs-search"]?.export_error, "db down");
  assert.match(by["host-verdicts"]?.export_error ?? "", /no exporter function supplied/);
  assert.deepEqual(p.kinds.slice(0, 2).map((k) => k.kind), ["theme-briefs", "question-answers"], "the oldest pending kind comes first");
});

test("finishDrain releases every lease the plan took, records a release that throws instead of losing it, and builds the run body with the residue as defects", async () => {
  const d = drainDeps({ exporters: { "theme-briefs": ex([{ theme_id: U(1) }, { theme_id: U(2) }]) } });
  const plan = await planDrain(d.deps, { runId: "r8", kindId: "theme-briefs" });
  const release = async (id: string) => { if (id === U(2)) throw new Error("rpc down"); d.released.push(id); return true; };
  const fin = await finishDrain({ release, now: () => NOW }, plan, { "theme-briefs": "https://example.test/pr/1" });
  assert.deepEqual(d.released, [U(1)]);
  assert.equal(fin.run.metrics.leases_released, 1);
  assert.match(JSON.stringify(fin.run.defectsFound), /not released.*rpc down/);
  assert.equal(fin.run.config.kinds.find((k) => k.kind === "theme-briefs")?.pr, "https://example.test/pr/1");
  assert.equal(fin.run.perItem.length, 2);
});

test("the kinds: eight, each with an exporter id and an apply step (no workflow filenames), one batch per kind per run, a batch path maps back to its kind", () => {
  assert.deepEqual(KIND_ORDER, ["ledger-verdicts", "host-verdicts", "needs-search", "question-answers", "theme-briefs", "record-briefs", "theme-classification", "screen-verdict"]);
  assert.ok(DRAIN_KINDS.every((k) => k.applyStep && k.maxBatchesPerRun === 1 && !JSON.stringify(k).includes(".yml")));
  assert.equal(kindForBatchPath("drain/batches/theme-briefs/theme-briefs-003.json")?.id, "theme-briefs");
  assert.equal(kindForBatchPath("drain/batches/theme-briefs/nested/theme-briefs-003.json"), null);
  assert.equal(kindForBatchPath("drain/batches/theme-briefs/other-003.json"), null);
  assert.equal(resolveKind("screen")?.id, "screen-verdict");
  assert.equal(resolveKind("theme"), null, "an ambiguous prefix names no kind");
  assert.equal(resolveKind("record-briefs")?.id, "record-briefs");
  assert.equal(kindForBatchPath("drain/batches/record-briefs/record-briefs-012a-x.json")?.id, "record-briefs");
});

test("IMP-039: the screen-verdict kind exports the ambiguous holds P2-05 banked and its apply step writes a session batch into screen_verdicts, refusing a bad row by name; the theme kind exports only what the rules left unclassified", async () => {
  const hold = (id: string, over: object = {}) => ({ id, title: `Doc ${id}`, document_url: `https://eur-lex.europa.eu/${id}`, dryrun_disposition: "hold", hold_reason: "screen:ambiguous:rule_x", notes: JSON.stringify({ export_kind: "screen-verdict" }), ...over });
  const db = memoryDb({ census_worklist: [hold(U(1)), hold(U(2), { notes: JSON.stringify({ export_kind: "other" }) }), hold(U(3), { hold_reason: "capture:empty" }), hold(U(4), { notes: "not json" })] });
  const out = await screenVerdictExporter(db.db)({ limit: 10, mode: "pending" });
  assert.deepEqual(out.items.map((i) => i.census_id), [U(1)]);
  const batch = { verdicts: [{ census_id: U(1), verdict: "off_vertical", basis: "ruling 2026-10-15", reviewer: "session" }, { census_id: "nope", verdict: "on_vertical", basis: "x" }, { census_id: U(2), verdict: "maybe", basis: "x" }, { census_id: U(3), verdict: "on_vertical", basis: "  " }] };
  const dry = await applyScreenVerdictBatch({ sb: db.db, now: () => NOW }, batch);
  assert.deepEqual([dry.planned, dry.written, dry.refused.length], [1, 0, 3]);
  assert.equal(db.tables.screen_verdicts, undefined);
  const live = await applyScreenVerdictBatch({ sb: db.db, now: () => NOW }, batch, { dry: false });
  assert.equal(live.written, 1);
  assert.deepEqual([db.tables.screen_verdicts?.[0]?.verdict, db.tables.screen_verdicts?.[0]?.basis], ["off_vertical", "ruling 2026-10-15"]);
  await assert.rejects(() => applyScreenVerdictBatch({ sb: memoryDb({}, { failures: [{ table: "screen_verdicts", op: "upsert", message: "fk" }] }).db, now: () => NOW }, batch, { dry: false }), /writing screen_verdicts failed/);
  const items = memoryDb({ intelligence_items: [{ id: "a", item_type: "research_finding", theme: null, is_archived: false, title: "Sustainable aviation fuel supply", what_is_it: "SAF feedstock" }, { id: "b", item_type: "research_finding", theme: null, is_archived: false, title: "Port congestion study" }, { id: "c", item_type: "research_finding", theme: "fuels_saf", is_archived: false, title: "x" }] });
  const themes = await themeClassificationExporter(items.db, classifyTheme)({ limit: 10, mode: "pending" });
  assert.deepEqual(themes.items.map((i) => i.id), ["b"]);
  const leases = leaseDeps(memoryDb({}, { rpc: (n) => (n === "acquire_mutation_lease" ? { data: [{ acquired: true, cur_holder: "h" }] } : { data: [{ released: true }] }) }).db);
  assert.deepEqual(await leases.acquire(U(1), "h", "judgement-drain", 10800), { acquired: true, cur_holder: "h" });
  assert.equal(await leases.release(U(1), "h"), true);
});
