// FIX-NOOP-1 (ruled run 40202525249): a run whose every output already exists is a success with zero rows (idempotence, INV-ARM-3), and a run that FAILED says why in its own ledger reason.
// The ruled run's bls-oews step failed on an HTTP 503 from the source, but its row (and the job table) carried "nothing new to insert (every generated question already has an open flag)", the first note of the stage, a benign note of a part that was ok.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classify } from "@/core/harness/outcome";
import type { FamilyCall } from "@/core/harness";
import { generateTriggerQuestions, writeQuestions } from "@/features/learning";
import { shapeChange, shapeConnect, shapePropagate, runPropagate } from "@/core/turn";
import { runRegistered } from "@/core/producers/registry";
import { runResult } from "@/core/types/run-result";
import type { ProducerSpec } from "@/core/producers/runner";

import { fixture, NOW } from "../integration/world.ts";
import { makeDeps } from "../producers/support.ts";

const NOTHING_NEW = "nothing new to insert (every generated question already has an open flag)";
const BLS_503 = "bls-oews: network: HTTP 503 Service Unavailable for https://api.bls.gov/publicAPI/v2/timeseries/data/";
const call = (over: Partial<FamilyCall>): FamilyCall => ({ mode: "apply", dry: false, input: {}, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", ...over }) as FamilyCall;

test("a second write of questions that all have an open flag is ok with zero written and says so (idempotence, never a failure)", async () => {
  const f = fixture();
  const questions = generateTriggerQuestions({ id: "item-1", title: "T", domain: 1 });
  assert.ok(questions.length > 0);
  const first = await writeQuestions({ sb: f.d.sb, now: () => NOW }, { dry: false, questions });
  assert.equal(first.outcome, "ok");
  assert.equal(first.counts.written, questions.length);
  const again = await writeQuestions({ sb: f.d.sb, now: () => NOW }, { dry: false, questions });
  assert.equal(again.outcome, "ok");
  assert.equal(again.counts.written, 0);
  assert.equal(again.counts.already_open, questions.length);
  assert.equal(again.notes[0], NOTHING_NEW);
});

test("the stage result of a failed producer leads with the producer's failure, not with a benign note of a part that was ok; the ledger reason follows it", () => {
  const r = shapePropagate({ producers: runResult("failed", { selected: 1 }, [BLS_503, "registry producer bls-oews failed; stopping", "registry producers: mode=apply selected=bls-oews"]), drain: runResult("ok", { drained: 467 }), questions: runResult("ok", { already_open: 4 }, [NOTHING_NEW]), signposts: runResult("ok"), assess: null }, [], []);
  assert.equal(r.outcome, "failed");
  assert.equal(r.notes[0], BLS_503);
  assert.ok(r.notes.includes(NOTHING_NEW), "the benign note is kept, behind the failure");
  assert.equal(classify(r, ["drained"], "apply").reason, BLS_503);
});

test("a stage whose parts are all ok keeps its notes in the order of its parts (the order change is for failed and partial parts only)", () => {
  const r = shapePropagate({ producers: runResult("ok", {}, ["p"]), drain: runResult("ok", {}, ["d"]), questions: runResult("ok", {}, ["q"]), signposts: runResult("ok", {}, ["s"]), assess: null }, [], []);
  assert.deepEqual(r.notes, ["d", "q", "s", "p"]);
});

test("the same lead-with-the-failure rule holds for the change and connect stage results", () => {
  const ok = runResult("ok", {}, ["benign"]);
  const bad = runResult("failed", {}, ["the real failure"]);
  assert.equal(shapeChange(ok, bad, []).notes[0], "the real failure");
  assert.equal(shapeConnect([], { tag: ok, discovery: bad, term: null, corpus: null }).notes[0], "the real failure");
});

test("a registry run whose producer failed leads with that producer's failure, not with the registry header; a genuine failure still fails", async () => {
  const bad: ProducerSpec = { name: "bad", table: "market_series", licenceKey: null, enabled: true, killSwitchEnv: null, fetchDoc: async () => ({ text: "x" }), parse: () => { throw new Error("boom"); } };
  const entries = [{ name: "bad", domain_table: "market_series", source: "s", licence: "l", dry_capable: true as const, enabled_env: null, in_all: true }];
  const r = await runRegistered(makeDeps({ noDb: true }).deps, { catalog: { bad }, entries });
  assert.equal(r.outcome, "failed");
  assert.match(r.notes[0] as string, /boom/);
});

test("a real propagate run whose source answers 503 fails, and its first note is the 503", async () => {
  const f = fixture({ routes: { "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml": () => new Response("down", { status: 503, statusText: "Service Unavailable" }) } });
  const r = await runPropagate(call({ input: { producers: { only: "ecb-fx" } } }), f.d);
  assert.equal(r.outcome, "failed");
  assert.match(r.notes[0] as string, /HTTP 503/);
});
