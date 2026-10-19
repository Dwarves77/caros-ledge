// The harness: one recorder, one row per firing, the no-op contract, the forged-upstream attack, the kill switch read first, the credentials gate, the build-mode gate (INV-051), a dry run that claims no write (INV-200).
// INV-058 (a unique run id) is retired by migration 0008: the id is a uuid minted by the recorder, so there is no second numbering authority and no file to rename.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, FAMILIES, makeRecorder, noopContractErrors, outcomeOf, recordRun, resolveMode, runChain, runFamily, validateFamilies, withRunContext, type FamilyFn, type HarnessDeps, type RecorderContext } from "@/core/harness";
import { runResult } from "@/core/types/run-result";

import { MemDb } from "../_support/memdb.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function world(cadence: "off" | "weekly" = "weekly") {
  const db = new MemDb();
  db.seed("system_state", [{ id: true, scrape_cadence: cadence, scrape_start_date: "2026-10-15", global_processing_paused: false }]);
  return db;
}
const harness = (db: MemDb | null, fns: Record<string, FamilyFn>, env: Record<string, string | undefined> = {}): HarnessDeps => ({ sb: db ? db.client : null, env, now: () => NOW, fns });
const rows = (db: MemDb) => db.rows("harness_runs");
const ok = (counts: Record<string, number>): FamilyFn => async () => runResult("ok", counts, []);

test("the recorder writes exactly one row for success, noop, refused, failed and a thrown function", async () => {
  const db = world();
  const fns: Record<string, FamilyFn> = {
    "source-sweep": ok({ upserted: 3 }),
    "research-walker": ok({ upserted: 0, minted: 0 }),
    "change-detection": async () => runResult("failed", { refused: 1 }, ["REFUSING: the gate"]),
    "fetch-drain": async () => runResult("failed", {}, ["boom"]),
    "ledger-consume": async () => {
      throw new Error("thrown");
    },
  };
  const h = harness(db, fns);
  const results = [];
  for (const name of ["source-sweep", "research-walker", "change-detection", "fetch-drain", "ledger-consume"]) results.push(await runFamily(name, { mode: "apply", trigger: "dispatch" }, h));
  assert.deepEqual(results.map((r) => r.row?.outcome), ["success", "noop", "refused", "failed", "failed"]);
  assert.equal(rows(db).length, 5, "one row per firing, no more");
  for (const r of rows(db)) {
    assert.match(String(r.id), UUID, "INV-058 retired: a uuid minted by the recorder");
    assert.ok(r.finished_at && Date.parse(String(r.finished_at)) >= Date.parse(String(r.started_at)), "finished_at is always written");
    assert.equal(r.root_run_id, r.id, "a chain head is its own root");
  }
  assert.match(String(rows(db)[4]?.error), /thrown/);
  assert.equal(rows(db)[0]?.mode, "apply");
});

test("INV-200: a dry run records zero writes, its counts under planned", async () => {
  const db = world("weekly");
  const r = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(db, { "source-sweep": ok({ upserted: 40 }) }));
  assert.equal(r.row?.outcome, "success");
  const out = rows(db)[0]?.outputs as Record<string, unknown>;
  assert.deepEqual(out.planned, { upserted: 40 });
  assert.equal(out.counts, undefined, "a dry row claims no write");
});

test("the no-op contract: a noop row that claims a write is refused and nothing is stored; so is a success in apply mode with no write", async () => {
  const db = world();
  const base = { id: "a0000000-0000-4000-8000-000000000001", family: "source-sweep", root_run_id: "a0000000-0000-4000-8000-000000000001", upstream_run_id: null, trigger: "dispatch" as const, forced_dry: false, reason: null, inputs: {}, error: null, code_sha: null, github_run_id: null, started_at: NOW.toISOString(), finished_at: NOW.toISOString() };
  const lying = await recordRun(db.client, { ...base, outcome: "noop", mode: "apply", outputs: { counts: { upserted: 2 } } });
  assert.match(String(lying.error), /no-op contract/);
  const forged = await recordRun(db.client, { ...base, id: "a0000000-0000-4000-8000-000000000002", outcome: "success", mode: "apply", outputs: { counts: { upserted: 0 } } });
  assert.match(String(forged.error), /no apply evidence/);
  const dry = await recordRun(db.client, { ...base, id: "a0000000-0000-4000-8000-000000000003", outcome: "success", mode: "dry", outputs: { counts: { upserted: 5 } } });
  assert.match(String(dry.error), /planned/);
  assert.equal(rows(db).length, 0, "nothing stored");
  assert.deepEqual(noopContractErrors({ outcome: "noop", mode: "apply", outputs: { counts: {} } }, ["upserted"]), []);
  assert.equal((await recordRun(db.client, { ...base, family: "no-such-family", outcome: "noop", mode: "apply", outputs: { counts: {} } })).error?.includes("not in FAMILIES"), true);
  assert.equal((await recordRun(null, { ...base, outcome: "noop", mode: "apply", outputs: { counts: {} } })).error?.includes("no database client"), true);
});

test("the forged-upstream attack: a success row with no apply evidence does not admit the downstream, and its function is never called", async () => {
  const db = world();
  const ROOT = "b0000000-0000-4000-8000-000000000001";
  // The attacker writes the ledger directly: a success in apply mode that claims nothing was written.
  db.seed("harness_runs", [{ id: ROOT, family: "source-sweep", root_run_id: ROOT, upstream_run_id: null, trigger: "dispatch", mode: "apply", forced_dry: false, outcome: "success", reason: null, inputs: {}, outputs: { counts: { upserted: 0 }, ids: { swept_source_ids: ["x"] } }, error: null, code_sha: null, github_run_id: null, started_at: NOW.toISOString(), finished_at: NOW.toISOString() }]);
  let called = 0;
  const h = harness(db, { "research-walker": async () => (called++, runResult("ok", { minted: 1 }, [])) });
  const r = await runFamily("research-walker", { mode: "apply", trigger: "chained", rootRunId: ROOT, upstreamRunId: ROOT }, h);
  assert.equal(r.row?.outcome, "refused");
  assert.match(String(r.row?.reason), /no-op contract|no apply evidence/);
  assert.equal(called, 0);
  // A row that claims a family it is not a downstream of is refused too.
  db.rows("harness_runs")[0]!.outputs = { counts: { upserted: 3 } };
  const wrong = await runFamily("propagation", { mode: "apply", trigger: "chained", rootRunId: ROOT, upstreamRunId: ROOT }, harness(db, { propagation: ok({ drained: 1 }) }));
  assert.equal(wrong.row?.outcome, "refused");
  assert.match(String(wrong.row?.reason), /not a declared downstream/);
  // With real evidence the same hand-off proceeds, and the downstream row carries the upstream id and the root.
  const good = await runFamily("research-walker", { mode: "apply", trigger: "chained", rootRunId: ROOT, upstreamRunId: ROOT }, harness(db, { "research-walker": ok({ minted: 1 }) }));
  assert.equal(good.row?.outcome, "success");
  assert.deepEqual([good.row?.upstream_run_id, good.row?.root_run_id], [ROOT, ROOT]);
  // A missing upstream is refused, never assumed.
  const none = await runFamily("research-walker", { mode: "apply", trigger: "chained", rootRunId: ROOT, upstreamRunId: "b0000000-0000-4000-8000-0000000000ff" }, harness(db, { "research-walker": ok({ minted: 1 }) }));
  assert.equal(none.row?.outcome, "refused");
});

test("the kill switch: an open fleet-budget-halt flag refuses every family, and it is the FIRST read", async () => {
  const db = world();
  db.seed("integrity_flags", [{ category: "budget", subject_type: "fleet", subject_ref: "fleet-budget-halt", status: "open", created_by: "operator", description: "halt" }]);
  let called = 0;
  const fns = Object.fromEntries(FAMILIES.filter((f) => f.stage).map((f) => [f.name, async () => (called++, runResult("ok", { upserted: 1 }, []))]));
  for (const f of FAMILIES.filter((x) => x.stage)) {
    const before = db.calls.length;
    const r = await runFamily(f.name, { mode: "apply", trigger: "dispatch" }, harness(db, fns));
    assert.equal(r.row?.outcome, "refused", f.name);
    assert.equal(db.calls[before]?.table, "integrity_flags", `${f.name}: the first read is the kill switch`);
    assert.equal(db.calls.slice(before).filter((c) => c.table === "system_state").length, 0, "no cadence read precedes or follows a halt");
  }
  assert.equal(called, 0);
  // An unreadable flag table is a halt too (fail closed).
  const db2 = world();
  db2.fail("integrity_flags", "select", "down");
  const r2 = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(db2, { "source-sweep": ok({ upserted: 1 }) }));
  assert.equal(r2.row?.outcome, "refused");
  assert.match(String(r2.row?.reason), /unreadable/);
  // A resolved flag does not halt.
  const db3 = world();
  db3.seed("integrity_flags", [{ category: "budget", subject_type: "fleet", subject_ref: "fleet-budget-halt", status: "resolved", created_by: "operator", description: "halt" }]);
  assert.equal((await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(db3, { "source-sweep": ok({ upserted: 1 }) }))).row?.outcome, "success");
});

test("the credentials gate: no client self-skips with exit 2 locally and fails loud with exit 1 in CI; nothing is recorded", async () => {
  const local = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(null, {}));
  assert.deepEqual([local.exit, local.row], [2, null]);
  const ci = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(null, {}, { CI: "true" }));
  assert.equal(ci.exit, 1);
  assert.match(String(ci.error), /missing \(exit 1\): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  await assert.rejects(runFamily("not-a-family", { mode: "dry", trigger: "dispatch" }, harness(null, {})), /not in FAMILIES/);
});

test("INV-051 and rule 16: cadence off forces dry for apply, chained and machine-fired runs; an unreadable cadence is off; apply needs a dispatch with the cadence on", async () => {
  const off = world("off");
  const sb = off.client;
  assert.deepEqual(await resolveMode(sb, { mode: "apply", trigger: "dispatch" }), { mode: "dry", forcedDry: true, reason: "forced dry: scrape cadence is off (build mode, rule 16)" });
  assert.equal((await resolveMode(sb, { mode: "apply", trigger: "chained" })).forcedDry, true);
  assert.equal((await resolveMode(sb, { mode: "dry", trigger: "dispatch" })).forcedDry, false);
  const broken = world("weekly");
  broken.fail("system_state", "select", "read error");
  assert.equal((await resolveMode(broken.client, { mode: "apply", trigger: "dispatch" })).mode, "dry", "a cadence read error fails closed");
  const on = world("weekly");
  assert.equal((await resolveMode(on.client, { mode: "apply", trigger: "dispatch" })).mode, "apply");
  assert.equal((await resolveMode(on.client, { mode: "apply", trigger: "schedule" })).forcedDry, true, "a scheduled firing is machine-fired");
  assert.equal((await resolveMode(on.client, { mode: "apply", trigger: "push" })).forcedDry, true);
  // The frame records the forced dry and the reason on the row, and the function is told dry.
  let seen = "";
  await runFamily("source-sweep", { mode: "apply", trigger: "dispatch" }, harness(off, { "source-sweep": async (c) => ((seen = c.mode), runResult("ok", { upserted: 9 }, [])) }));
  assert.equal(seen, "dry");
  const row = rows(off)[0]!;
  assert.deepEqual([row.mode, row.forced_dry, row.outcome], ["dry", true, "success"]);
  assert.match(String(row.reason), /cadence is off/);
});

test("a chain threads one root id, each stage the next one's upstream; a failed stage makes every later stage a recorded noop, a refused one does not stop the chain", async () => {
  const db = world();
  const fns: Record<string, FamilyFn> = { "source-sweep": ok({ upserted: 2 }), "research-walker": async () => runResult("failed", {}, ["broke"]), "change-detection": ok({ checked: 1 }), "fetch-drain": ok({ captured: 1 }) };
  const runs = await runChain(["source-sweep", "research-walker", "change-detection", "fetch-drain"], { mode: "apply", trigger: "dispatch" }, harness(db, fns));
  assert.equal(runs.length, 4);
  assert.equal(new Set(rows(db).map((r) => r.root_run_id)).size, 1);
  assert.deepEqual(rows(db).map((r) => r.outcome), ["success", "failed", "noop", "noop"]);
  assert.deepEqual(rows(db).map((r) => r.upstream_run_id), [null, rows(db)[0]?.id, rows(db)[1]?.id, rows(db)[2]?.id]);
  assert.equal(rows(db)[0]?.id, rows(db)[0]?.root_run_id);
  assert.match(String(rows(db)[2]?.reason), /did not run/);
  // A stage held by its own gate (refused) hands nothing over, and the next stage still runs on its own selection.
  const held = world();
  const runs2 = await runChain(["source-sweep", "research-walker", "change-detection"], { mode: "apply", trigger: "dispatch" }, harness(held, { "source-sweep": ok({ upserted: 2 }), "research-walker": async () => runResult("failed", { refused: 1 }, ["REFUSING: gate"]), "change-detection": ok({ checked: 1 }) }));
  assert.deepEqual(held.rows("harness_runs").map((r) => r.outcome), ["success", "refused", "success"]);
  assert.equal(runs2[2]?.row?.upstream_run_id, held.rows("harness_runs")[1]?.id);
});

test("the recorder the runtimes call writes a row per unit under the running family's root, and none when nothing is running", async () => {
  const db = world();
  const rec = makeRecorder(db.client, () => NOW);
  assert.match(String((await rec.recordRun({ family: "mint", itemId: "i1", outcome: "ok", counts: { claims: 3 }, notes: [] })).error), /no run is in progress/);
  const ctx: RecorderContext = { rootRunId: "c0000000-0000-4000-8000-000000000001", upstreamRunId: null, mode: "apply", trigger: "dispatch", forcedDry: false, codeSha: "abc", githubRunId: "7" };
  await withRunContext(ctx, async () => {
    assert.equal((await rec.recordRun({ family: "mint", itemId: "i1", outcome: "ok", counts: { claims: 3 }, notes: [] })).error, null);
    assert.equal((await rec.recordRun({ family: "mint", itemId: "i2", outcome: "ok", counts: { claims: 0 }, notes: [] })).error, null, "an apply unit that wrote nothing is a noop row");
    assert.match(String((await rec.recordRun({ family: "bogus", outcome: "ok", counts: {}, notes: [] })).error), /not in FAMILIES/);
    const refusing = new MemDb();
    refusing.fail("harness_runs", "insert", "disk full");
    assert.match(String((await makeRecorder(refusing.client, () => NOW).recordRun({ family: "mint", outcome: "ok", counts: { claims: 1 }, notes: [] })).error), /disk full/);
  });
  assert.deepEqual(rows(db).map((r) => [r.family, r.outcome, r.root_run_id, r.code_sha, (r.inputs as Record<string, unknown>).item_id]), [["mint", "success", ctx.rootRunId, "abc", "i1"], ["mint", "noop", ctx.rootRunId, "abc", "i2"]]);
});

test("a failed record is the run's error: the frame reports exit 1 and no row", async () => {
  const db = world();
  db.fail("harness_runs", "insert", "disk full");
  const r = await runFamily("source-sweep", { mode: "dry", trigger: "dispatch" }, harness(db, { "source-sweep": ok({ upserted: 1 }) }));
  assert.equal(r.exit, 1);
  assert.match(String(r.error), /disk full/);
  assert.equal(r.row, null);
});

test("classify and outcomeOf", () => {
  const w = ["upserted"];
  assert.deepEqual(classify(runResult("ok", { upserted: 2 }), w, "apply"), { outcome: "success", reason: null });
  assert.equal(classify(runResult("ok", { upserted: 0 }), w, "apply").outcome, "noop");
  assert.equal(classify(runResult("ok", { upserted: 0 }), w, "dry").outcome, "success");
  assert.deepEqual(classify(runResult("partial", { upserted: 1 }, ["one failed"]), w, "apply"), { outcome: "partial", reason: "one failed" }, "a run with failed units is partial, never success");
  assert.equal(classify(runResult("partial", { upserted: 0 }, ["all failed"]), w, "apply").outcome, "noop", "a partial that wrote nothing is still a noop: no apply evidence");
  assert.equal(classify(runResult("failed", { refused: 1 }, ["gate"]), w, "apply").outcome, "refused");
  assert.equal(classify(runResult("failed", { refused: 1, upserted: 2 }, ["gate"]), w, "apply").outcome, "failed", "a refusal that also wrote is a failure");
  assert.equal(outcomeOf(["success", "failure"]), "failure");
  assert.equal(outcomeOf(["skipped", "skipped"]), "skipped");
  assert.equal(outcomeOf([]), "skipped");
  assert.equal(outcomeOf(["success", "cancelled"]), "cancelled");
  assert.equal(outcomeOf(["success", "skipped"]), "success");
});

test("the family table: valid as shipped, and a broken table reports its problems instead of throwing", () => {
  assert.deepEqual(validateFamilies().problems, []);
  const bad = validateFamilies([
    { name: "a", owner: "x", stage: null, downstream: ["ghost"], writes: [] },
    { name: "a", owner: "x", stage: null, downstream: [], writes: [] },
  ]);
  assert.deepEqual(bad.problems.sort(), ["a: downstream ghost is not a family", "a: no downstream and no stated reason it ends", "duplicate family a"].sort());
  assert.ok(validateFamilies([{ name: "Bad Name" }]).problems.length > 0);
});
