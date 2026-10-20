import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBatch, exportBatch } from "@/features/batches";
import { questionExporter } from "@/features/batches/kinds/question-answers/apply";

import { batchFile, ITEM, SPAN_FORCE, SPAN_REPORT } from "./world.ts";
import { qaWorld, REF, type World } from "./worlds.ts";

const bundleOf = async (w: World) => {
  const r = await questionExporter(w.db.client)({ limit: 10 });
  assert.equal(r.ok, true, r.error);
  return r.items[0] as { subject_ref: string; pool_hash: string; needs: string };
};
const answered = (hash: string, over: Record<string, unknown> = {}) => ({ subject_ref: REF, outcome: "answered", pool_hash: hash, status_token: "CONFIRMED", confidence: 0.9, answer: SPAN_REPORT, cited_item_ids: [ITEM], evidence: [{ item_id: ITEM, claim_ids: [], source_span: SPAN_REPORT }], ...over });
const apply = (w: World, entries: unknown[], dry = false) => applyBatch("question-answers", w.deps, { content: JSON.stringify(batchFile("question-answers", entries)), dry });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const flag = (w: World) => w.db.rows("integrity_flags").find((f) => f.subject_ref === REF && f.created_by === "question:what") as Record<string, unknown>;

test("the export lists the open question with the held pool's identity; the answer applies as an INFERENCE record and closes the question naming it, then flushes the item's cache", async () => {
  const w = qaWorld();
  const b = await bundleOf(w);
  assert.deepEqual([b.subject_ref, b.needs], [REF, "unanswered"]);
  const r = await apply(w, [answered(b.pool_hash)]);
  assert.equal(r.counts.applied, 1, notes(r));
  assert.equal(r.outcome, "ok", notes(r));
  const inf = w.db.rows("inference_records");
  assert.equal(inf.length, 1);
  assert.deepEqual([inf[0]?.status_token, inf[0]?.trigger_question_ref, inf[0]?.cited_item_ids], ["CONFIRMED", REF, [ITEM]]);
  assert.equal(flag(w).status, "resolved");
  assert.match(String(flag(w).resolution_note), new RegExp(String(inf[0]?.inference_id)));
  assert.equal(w.db.rows("section_claim_provenance").length, 0, "an answer is never written as a fact");
  assert.ok(w.flushed.some((t) => t.includes(`item:${ITEM}`)), "the answered item's cache was flushed");
  // re-apply: nothing new
  const writes = w.db.writes().length;
  const again = await apply(w, [answered(b.pool_hash)]);
  assert.deepEqual([again.counts.already_applied, again.counts.applied], [1, 0]);
  assert.equal(w.db.writes().length, writes);
  assert.equal((await questionExporter(w.db.client)({ limit: 10 })).items.length, 0, "an answered question with an unchanged pool is not exported again");
});

test("INV-208 attack: CONFIRMED with one paraphrased sentence is refused; the same answer as HYPOTHESIS is accepted; a figure no evidence carries is refused", async () => {
  const w = qaWorld();
  const { pool_hash } = await bundleOf(w);
  const mixed = `${SPAN_REPORT} Operators will therefore need a dedicated compliance team.`;
  const refused = await apply(w, [answered(pool_hash, { answer: mixed })]);
  assert.equal(refused.counts.applied ?? 0, 0);
  assert.match(notes(refused), /status_token CONFIRMED needs every sentence quoted/);
  assert.equal(w.db.rows("inference_records").length, 0);
  const hyp = await apply(w, [answered(pool_hash, { answer: mixed, status_token: "HYPOTHESIS" })]);
  assert.equal(hyp.counts.applied, 1, notes(hyp));
  assert.equal(w.db.rows("inference_records")[0]?.status_token, "HYPOTHESIS");
  const w2 = qaWorld();
  const h2 = (await bundleOf(w2)).pool_hash;
  const loose = await apply(w2, [answered(h2, { answer: `${SPAN_REPORT} The fine can reach EUR 1 000 000.`, status_token: "HYPOTHESIS" })]);
  assert.match(notes(loose), /answer states "1,000,000"|answer states .*that no evidence span/);
});

test("INV-207 / INV-208: a stale held pool, a paraphrased evidence span, a wrong cited set, an uncitable item and a non-open question are each refused", async () => {
  const w = qaWorld();
  const { pool_hash } = await bundleOf(w);
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["stale pool", { pool_hash: "0".repeat(64) }, /stale pool/],
    ["paraphrased evidence", { evidence: [{ item_id: ITEM, claim_ids: [], source_span: "Operators have to submit emissions figures each spring to the regulator." }] }, /not a verbatim substring of the held pool text/],
    ["cited set differs", { cited_item_ids: [ITEM, "a0000000-0000-4000-8000-0000000000ff"] }, /cited_item_ids must equal the set of evidence item ids/],
    ["a claim id that is not the item's", { evidence: [{ item_id: ITEM, claim_ids: ["nope"], source_span: SPAN_REPORT }] }, /not a grounded claim of the cited item/],
    ["short span", { evidence: [{ item_id: ITEM, claim_ids: [], source_span: "shall report" }] }, /too short to be evidence/],
    ["bad confidence", { confidence: 7 }, /confidence must be a number from 0 to 1/],
    ["REFUTED token", { status_token: "REFUTED" }, /status_token must be one of HYPOTHESIS, CONFIRMED/],
    ["an unanswerable entry that carries an answer", { outcome: "unanswerable_from_holdings", missing: "the delegated act", answer: "x" }, /carries no answer/],
  ];
  for (const [name, over, re] of cases) assert.match(notes(await apply(w, [answered(pool_hash, over)])), re, name);
  assert.equal(w.db.rows("inference_records").length, 0);
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).origin_class = "community";
  assert.match(notes(await apply(w, [answered(pool_hash)])), /not citable \(sourced only from Community/);
  assert.equal((await questionExporter(w.db.client)({ limit: 10 })).items.length, 0, "a question whose item cannot be cited is not exported");
});

test("an unanswerable question records the outcome on its flag and raises ONE holdings-need target the research walker reads; a second apply refreshes nothing; a changed pool re-asks", async () => {
  const w = qaWorld();
  const { pool_hash } = await bundleOf(w);
  const entry = { subject_ref: REF, outcome: "unanswerable_from_holdings", pool_hash, missing: "the delegated act that sets the competent authority for third-country operators" };
  const r = await apply(w, [entry]);
  assert.equal(r.counts.applied, 1, notes(r));
  const targets = w.db.rows("integrity_flags").filter((f) => String(f.created_by).startsWith("holdings-need:"));
  assert.equal(targets.length, 1);
  assert.match(String(targets[0]?.description), /delegated act/);
  assert.equal(flag(w).status, "open", "the question itself stays open");
  assert.equal((flag(w).recommended_actions as { action: string }[]).some((a) => a.action === "unanswerable_from_holdings"), true);
  const again = await apply(w, [entry]);
  assert.equal(again.counts.already_applied, 1);
  assert.equal(w.db.rows("integrity_flags").filter((f) => String(f.created_by).startsWith("holdings-need:")).length, 1);
  assert.equal((await questionExporter(w.db.client)({ limit: 10 })).items.length, 0, "unchanged pool: not asked again");
  w.db.seed("agent_run_searches", [{ intelligence_item_id: ITEM, result_url: "https://eur-lex.europa.eu/more", result_content: `${SPAN_FORCE} `.repeat(8), result_index: 5 }]);
  const re = (await questionExporter(w.db.client)({ limit: 10 })).items[0] as { needs: string; pool_hash: string };
  assert.deepEqual(re.needs, "reasked_after_new_holdings");
  const a2 = await apply(w, [answered(re.pool_hash)]);
  assert.equal(a2.counts.applied, 1, notes(a2));
  assert.equal(w.db.rows("integrity_flags").filter((f) => String(f.created_by).startsWith("holdings-need:") && f.status === "open").length, 0, "answering closes the target");
});

test("the export goes to a scratch directory outside the repository and refuses a directory inside it; the queue gets ids and part paths, never pool text", async () => {
  const w = qaWorld();
  const dir = (await import("node:os")).tmpdir();
  const inside = await exportBatch("question-answers", w.deps, { outDir: "tests/batches/out" });
  assert.equal(inside.outcome, "failed");
  assert.match(inside.notes[0] ?? "", /inside the repository/);
  const ok = await exportBatch("question-answers", w.deps, { outDir: `${dir}/caros-test-qa-${process.pid}`, runId: "r1" });
  assert.equal(ok.counts.exported, 1, ok.notes.join(";"));
  const ids = (ok.data as { ids: Record<string, string[]> }).ids;
  assert.deepEqual(ids.exported_ids, [REF]);
  assert.equal(ids.parts?.length, 1);
  assert.doesNotMatch(JSON.stringify(ok.data), /Operators shall report/, "the queue carries no pool text");
});
