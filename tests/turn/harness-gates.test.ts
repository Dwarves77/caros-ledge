// R1b / G7 and G3: the ledger and its proofs can go red. A run where units failed is `partial` and no proof counts it as success; an unreadable cadence is said to be unreadable; the proofs page the ledger in a total order;
// a run that began and never concluded is reaped as crashed; a closing update that fails once is tried again; two chains on one set of deps keep their own runs; a malformed count is refused, not read as zero; and the one
// exit-code contract (skip only where the event cannot carry secrets) holds for the run frame.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chainProof, countsOf, EXIT, makeRecorder, mintedIds, noopContractErrors, reapStaleRuns, recordRun, resolveMode, RUN_LEASE_MS, runChain, runFamily, skipVerdict, withRunContext, type FamilyFn, type HarnessDeps, type RunRow } from "@/core/harness";
import { readSliceState } from "@/core/turn";
import { runResult } from "@/core/types/run-result";

import { MemDb } from "../_support/memdb.ts";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const ROOT = "d0000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, over: Partial<RunRow> = {}): RunRow & Record<string, unknown> => ({ id: uuid(n), family: "source-sweep", root_run_id: ROOT, upstream_run_id: null, trigger: "dispatch", mode: "apply", forced_dry: false, outcome: "success", reason: null, inputs: {}, outputs: { counts: { upserted: 1 } }, error: null, code_sha: null, github_run_id: null, started_at: NOW.toISOString(), finished_at: NOW.toISOString(), ...over });
const world = (cadence: "off" | "weekly" = "weekly") => new MemDb().seed("system_state", [{ id: true, scrape_cadence: cadence, scrape_start_date: "2026-10-15", global_processing_paused: false }]);
const harness = (db: MemDb | null, fns: Record<string, FamilyFn>, env: Record<string, string | undefined> = {}, extra: Partial<HarnessDeps> = {}): HarnessDeps => ({ sb: db ? db.client : null, env, now: () => NOW, fns, sleep: async () => undefined, ...extra });
const ok = (counts: Record<string, number>): FamilyFn => async () => runResult("ok", counts, []);

test("G7: a stage whose units failed is `partial`, and chainProof is not ok on it (it used to read ok whenever no row was `failed`)", async () => {
  const db = world();
  const fns: Record<string, FamilyFn> = { "source-sweep": ok({ upserted: 3 }), "research-walker": async () => runResult("partial", { upserted: 1, minted: 1 }, ["one source failed to walk"]) };
  await runChain(["source-sweep", "research-walker"], { mode: "apply", trigger: "dispatch", rootRunId: ROOT }, harness(db, fns));
  assert.deepEqual(db.rows("harness_runs").map((r) => r.outcome), ["success", "partial"]);
  const proof = await chainProof(db.client, ROOT, ["source-sweep", "research-walker"]);
  assert.deepEqual([proof.ok, proof.partial, proof.failed, proof.missing], [false, ["research-walker"], [], []]);
  const clean = world();
  await runChain(["source-sweep", "research-walker"], { mode: "apply", trigger: "dispatch", rootRunId: ROOT }, harness(clean, { "source-sweep": ok({ upserted: 3 }), "research-walker": ok({ minted: 1 }) }));
  assert.equal((await chainProof(clean.client, ROOT, ["source-sweep", "research-walker"])).ok, true, "the same chain with no failed unit is ok");
});

test("a family that throws, or returns failed, is recorded as failed and exits 1; the chain stops there and every family behind it is recorded refused, so the ledger is complete and the proof is not ok", async () => {
  for (const broken of [async () => runResult("failed", {}, ["broke"]), async (): Promise<ReturnType<typeof runResult>> => { throw new Error("threw"); }] as FamilyFn[]) {
    const db = world();
    const runs = await runChain(["source-sweep", "research-walker", "change-detection"], { mode: "apply", trigger: "dispatch", rootRunId: ROOT }, harness(db, { "source-sweep": broken, "research-walker": ok({ minted: 1 }), "change-detection": ok({ checked: 1 }) }));
    assert.deepEqual(runs.map((r) => r.exit), [1, 0, 0]);
    assert.deepEqual(db.rows("harness_runs").map((r) => [r.family, r.outcome, r.reason]), [["source-sweep", "failed", db.rows("harness_runs")[0]!.reason], ["research-walker", "refused", "upstream source-sweep failed"], ["change-detection", "refused", "upstream source-sweep failed"]]);
    const proof = await chainProof(db.client, ROOT, ["source-sweep", "research-walker", "change-detection"]);
    assert.deepEqual([proof.ok, proof.missing, proof.failed, [...proof.held].sort()], [false, [], ["source-sweep"], ["change-detection:refused", "research-walker:refused"]]);
  }
});

test("G7: a partial mint still minted its items, so the minted ids and THE GATE count it", async () => {
  const db = world();
  const minted = row(1, { family: "ledger-consume", outcome: "partial", outputs: { counts: { minted: 2 }, ids: { minted_item_ids: ["i1", "i2"] } } });
  db.seed("harness_runs", [minted]);
  assert.deepEqual(await mintedIds(db.client), ["i1", "i2"]);
  assert.deepEqual((await readSliceState(db.client)).unconnected, ["i1", "i2"], "a partial mint left unconnected is a slice THE GATE refuses to start over");
});

test("G7: resolveMode says the cadence is unreadable, with the database's error, instead of saying it is off", async () => {
  const db = world("weekly");
  db.fail("system_state", "select", "connection reset by peer");
  const r = await resolveMode(db.client, { mode: "apply", trigger: "dispatch" });
  assert.deepEqual([r.mode, r.forcedDry], ["dry", true]);
  assert.match(String(r.reason), /scrape cadence is unreadable \(system_state read failed: connection reset by peer\)/);
  assert.doesNotMatch(String(r.reason), /cadence is off/, "an unknown cadence is not reported as a known one");
});

test("G7: the proofs and THE GATE page the ledger in a total order (started_at, id): started_at alone ties, and offset paging over ties skips rows", async () => {
  const db = world();
  db.seed("harness_runs", [row(1), row(2, { family: "research-walker" })]);
  await chainProof(db.client, ROOT);
  await mintedIds(db.client);
  await readSliceState(db.client);
  const reads = db.calls.filter((c) => c.table === "harness_runs" && c.op === "select");
  assert.equal(reads.length, 3);
  for (const c of reads) assert.deepEqual(c.orders.map(([col]) => col), ["started_at", "id"], "every ledger page is ordered by the pair");
});

test("G7: a firing that began and never concluded is reaped as crashed once the lease passes; a run still inside the lease and a legacy row are left alone", async () => {
  const db = world();
  const old = new Date(NOW.getTime() - RUN_LEASE_MS - 60_000).toISOString();
  const recent = new Date(NOW.getTime() - 60_000).toISOString();
  db.seed("harness_runs", [row(1, { outcome: "unknown", reason: "in progress", started_at: old }), row(2, { outcome: "unknown", reason: "in progress", started_at: recent }), row(3, { outcome: "unknown", reason: null, started_at: old, outputs: { legacy: true } })]);
  assert.equal(await reapStaleRuns(db.client, NOW), 1);
  const by = (n: number) => db.rows("harness_runs").find((r) => r.id === uuid(n)) as Record<string, unknown>;
  assert.deepEqual([by(1).outcome, by(1).reason, by(2).outcome, by(3).outcome], ["failed", "crashed", "unknown", "unknown"]);
  assert.match(String(by(1).error), /never concluded it/);
  // The reaper is part of every chain, not a function nothing calls.
  db.rows("harness_runs").push(row(4, { outcome: "unknown", reason: "in progress", started_at: old, id: uuid(4) }));
  await runChain(["source-sweep"], { mode: "dry", trigger: "dispatch" }, harness(db, { "source-sweep": ok({ upserted: 1 }) }));
  assert.equal(by(4).outcome, "failed");
  const broken = world();
  broken.fail("harness_runs", "update", "permission denied");
  await assert.rejects(reapStaleRuns(broken.client, NOW), /reaper failed: permission denied/);
});

test("G7: the closing update is tried again; after the last attempt the row stays `unknown` and the run's error says so", async () => {
  const flaky = world();
  flaky.fail("harness_runs", "update", "deadlock detected", { times: 2 });
  const done = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(flaky, { "source-sweep": ok({ upserted: 1 }) }));
  assert.equal(done.exit, 0, "two transient faults and a third attempt that lands");
  assert.equal(flaky.rows("harness_runs")[0]?.outcome, "success");
  const down = world();
  down.fail("harness_runs", "update", "disk full");
  const lost = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(down, { "source-sweep": ok({ upserted: 1 }) }));
  assert.equal(lost.exit, 1);
  assert.match(String(lost.error), /harness_runs update failed: disk full/);
  assert.equal(down.rows("harness_runs")[0]?.outcome, "unknown", "the evidence the firing began");
  assert.equal(down.writes("harness_runs", "update").length, 3, "three attempts, no more");
});

test("G7: two chains on one set of deps keep their own run context: each unit row lands under its own root", async () => {
  const db = world();
  const recorder = makeRecorder(db.client, () => NOW);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const unit = (item: string): FamilyFn => async () => {
    await gate; // both chains are inside their family call before either records its unit
    await recorder.recordRun({ family: "mint", itemId: item, outcome: "ok", counts: { claims: 1 }, notes: [] });
    return runResult("ok", { upserted: 1 }, []);
  };
  const a = runFamily("source-sweep", { mode: "apply", trigger: "dispatch", id: uuid(11) }, harness(db, { "source-sweep": unit("item-a") }));
  const b = runFamily("source-sweep", { mode: "apply", trigger: "dispatch", id: uuid(12) }, harness(db, { "source-sweep": unit("item-b") }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([a, b]);
  const units = db.rows("harness_runs").filter((r) => r.family === "mint").map((r) => [(r.inputs as { item_id: string }).item_id, r.root_run_id]);
  assert.deepEqual(units.sort(), [["item-a", uuid(11)], ["item-b", uuid(12)]]);
  // Outside a family call there is no run: the context does not outlive the call that set it.
  assert.match(String((await recorder.recordRun({ family: "mint", outcome: "ok", counts: {}, notes: [] })).error), /no run is in progress/);
  await withRunContext({ rootRunId: uuid(13), upstreamRunId: null, mode: "dry", trigger: "dispatch", forcedDry: false, codeSha: null, githubRunId: null }, async () => undefined);
});

test("C:100 and C:53: a malformed count is refused (not read as zero) and the counts of a row are read by one function that refuses a non-object", async () => {
  for (const bad of [-1, Number.NaN, "3" as unknown as number, Number.POSITIVE_INFINITY]) {
    assert.match(noopContractErrors({ outcome: "success", mode: "apply", outputs: { counts: { upserted: bad } } }, ["upserted"]).join(" "), /non-negative finite/, String(bad));
  }
  const db = world();
  const r = await recordRun(db.client, row(1, { outputs: { counts: { upserted: Number.NaN } } }));
  assert.match(String(r.error), /no-op contract.*non-negative finite/);
  assert.equal(db.rows("harness_runs").length, 0);
  assert.deepEqual(countsOf({ counts: { a: 1 } }), { a: 1 });
  assert.deepEqual(countsOf({ planned: { a: 2 } }), { a: 2 });
  assert.deepEqual(countsOf({ skipped: true }), {}, "a skipped or legacy row carries no counts");
  assert.throws(() => countsOf({ counts: "3" }), /not an object of numbers/);
  assert.throws(() => countsOf({ counts: [1] }), /not an object of numbers/);
});

test("G3: a run that cannot proceed for a missing secret skips only where the event cannot carry secrets (a fork PR); everywhere else it fails and names the missing names", () => {
  const dir = mkdtempSync(join(tmpdir(), "r1b-event-"));
  const event = (fork: boolean) => {
    const path = join(dir, `event-${fork}.json`);
    writeFileSync(path, JSON.stringify({ pull_request: { head: { repo: { fork } } } }));
    return path;
  };
  const names = ["SUPABASE_SERVICE_ROLE_KEY", "WORKER_SECRET"];
  assert.deepEqual(skipVerdict({ GITHUB_ACTIONS: "true" }, []), { exit: EXIT.ok, message: "" });
  const fork = skipVerdict({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event(true) }, names);
  assert.equal(fork.exit, EXIT.skipped);
  assert.match(fork.message, /fork cannot carry secrets; not set: SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET/);
  for (const env of [
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event(false) }, // a same-repo PR carries secrets
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "deployment_status" },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" }, // no readable payload: not provably a fork
  ]) {
    const v = skipVerdict(env, names);
    assert.equal(v.exit, EXIT.failed, JSON.stringify(env));
    assert.match(v.message, /SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET/);
  }
  assert.equal(skipVerdict({}, names).exit, EXIT.skipped, "a workstation with no credentials may skip");
  assert.equal(skipVerdict({}, names, true).exit, EXIT.failed, "but not for a check it was asked to run by name");
});
