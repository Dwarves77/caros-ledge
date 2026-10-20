// The turn runtime: the plan, the build-mode gate read once (rule 16: cadence off means a dry turn that touches nothing), THE GATE (INV-195), the kill switch across a whole turn, the credentials gate.
import assert from "node:assert/strict";
import { test } from "node:test";

import { gateRefusal, readSliceState, runTurn, STAGES } from "@/core/turn";

import { DOC_TEXT, DOC_URL, fixture, NOW } from "../integration/world.ts";

const input = { intake: { census: { limit: 5 } }, propagate: { producers: { only: "ecb-fx" } } };
const apply = (f: ReturnType<typeof fixture>, over: Partial<Parameters<typeof runTurn>[0]> = {}) => runTurn({ stage: "all", mode: "apply", input, ...over }, { d: f.d, env: {}, now: () => NOW });
const ledger = (f: ReturnType<typeof fixture>) => f.db.rows("harness_runs");
const capture = (f: ReturnType<typeof fixture>) => f.db.seed("agent_run_searches", [{ intelligence_item_id: null, result_url: DOC_URL, result_content: DOC_TEXT, result_index: 0, search_query: "capture-worker:first-fetch" }]);

test("the plan: all stages in order; one stage runs it and its downstream; chain false runs only that stage; an unknown stage is an error", async () => {
  const f = fixture();
  const planOf = async (stage: string, chain?: boolean) => (await runTurn({ stage: stage as never, mode: "dry", ...(chain === false ? { chain: false } : {}), input: {} }, { d: f.d, env: {}, now: () => NOW })).plan;
  assert.deepEqual(await planOf("all"), [...STAGES]);
  assert.deepEqual(await planOf("connect"), ["connect", "propagate", "briefs"]);
  assert.deepEqual(await planOf("connect", false), ["connect"]);
  await assert.rejects(() => planOf("nope"), /unknown stage/);
});

test("rule 16 drill: cadence off and mode apply requested: the fetching stages are dry and say why, the analysis stages work on stored data in the requested mode, and nothing reaches the network", async () => {
  const f = fixture({ cadence: "off" });
  const r = await apply(f);
  assert.equal(r.exit, 0);
  assert.deepEqual([r.resolved.mode, r.resolved.forcedDry], ["dry", true], "the turn reports its first stage, a fetching one");
  assert.equal(f.requests.urls.length, 0, "no request left the process: the producer the propagate stage was asked for is planned, not fetched");
  const rows = ledger(f);
  const fetching = ["source-sweep", "research-walker", "change-detection", "fetch-drain"];
  const analysis = ["ledger-consume", "corpus-turn", "propagation", "brief-apply"];
  for (const x of rows.filter((y) => fetching.includes(String(y.family)))) {
    assert.deepEqual([x.mode, x.forced_dry], ["dry", true], `${x.family} is held`);
    assert.match(String(x.reason), /cadence is off/);
  }
  for (const x of rows.filter((y) => analysis.includes(String(y.family)))) assert.deepEqual([x.mode, x.forced_dry], ["apply", false], `${x.family} honours the requested mode`);
  assert.ok(rows.filter((x) => fetching.includes(String(x.family))).every((x) => (x.outputs as { counts?: unknown }).counts === undefined), "a dry row claims no write (INV-200)");
  assert.equal(new Set(rows.map((x) => x.root_run_id)).size, 1, "one root");
  assert.equal(f.db.rows("intelligence_items").length, 0);
  assert.equal(rows.filter((x) => x.family === "producers").length, 0, "the producer was planned, not run: it fetches, and the fetch gate is closed");
  assert.equal((rows.find((x) => x.family === "propagation")?.outputs as { counts: Record<string, number> }).counts.producers_selected, 1);
});

test("a cadence read error fails closed: the turn is dry", async () => {
  const f = fixture();
  f.db.fail("system_state", "select", "read error");
  const r = await apply(f, { stage: "sweep", chain: false });
  assert.deepEqual([r.resolved.mode, r.resolved.forcedDry], ["dry", true]);
  assert.equal(f.requests.urls.length, 0);
});

test("a machine-fired turn (schedule) is dry even with the cadence on: apply needs an operator dispatch", async () => {
  const f = fixture();
  const r = await apply(f, { stage: "sweep", chain: false, trigger: "schedule" });
  assert.equal(r.resolved.mode, "dry");
  assert.match(String(r.resolved.reason), /machine-fired/);
});

test("the kill switch refuses every stage of a whole turn: eight refused rows, no stage function runs, no request", async () => {
  const f = fixture();
  f.db.seed("integrity_flags", [{ category: "budget", subject_type: "fleet", subject_ref: "fleet-budget-halt", status: "open", created_by: "operator", description: "halt" }]);
  const r = await apply(f);
  assert.equal(r.exit, 0);
  assert.deepEqual(ledger(f).map((x) => x.outcome), Array(8).fill("refused"));
  assert.equal(f.requests.urls.length, 0);
  assert.deepEqual(f.db.writes().filter((c) => c.table !== "harness_runs"), []);
});

test("no credentials: the turn self-skips with exit 2 locally and fails loud with exit 1 in CI; nothing is recorded", async () => {
  const local = await runTurn({ stage: "all", mode: "dry" }, { d: null, env: {}, now: () => NOW });
  assert.equal(local.exit, 2);
  const ci = await runTurn({ stage: "all", mode: "dry" }, { d: null, env: { CI: "true" }, now: () => NOW });
  assert.equal(ci.exit, 1);
});

test("a single stage with chain false records one row and says the chain was disabled; the default runs its downstream too (rule 17)", async () => {
  const f = fixture();
  const one = await apply(f, { stage: "propagate", chain: false });
  assert.deepEqual(one.runs.map((x) => x.row?.family), ["propagation"]);
  assert.equal((ledger(f).find((x) => x.family === "propagation")?.inputs as { chain_disabled?: boolean }).chain_disabled, true);
  const g = fixture();
  const chained = await apply(g, { stage: "propagate" });
  assert.deepEqual(chained.runs.map((x) => x.row?.family), ["propagation", "brief-apply"]);
  assert.equal(chained.runs[1]?.row?.upstream_run_id, chained.runs[0]?.row?.id);
});

test("INV-195 THE GATE: a minted slice nothing connected refuses the next mint; the connect stage closes the backlog from the ledger; then the mint runs again", async () => {
  const f = fixture();
  capture(f);
  const first = await apply(f, { stage: "intake", chain: false });
  const item = (ledger(f).find((x) => x.family === "ledger-consume")?.outputs as { ids: { minted_item_ids: string[] } }).ids.minted_item_ids[0] as string;
  // The fixture's cache flush is not configured and its tag tables are empty: the run minted the item and said so, which is `partial` (some steps failed), not `success`. THE GATE counts a partial mint.
  assert.equal(first.runs[0]?.row?.outcome, "partial");
  assert.ok(item);

  // The slice is minted and unconnected: the ledger says so, and a second mint is refused with the way out.
  const state = await readSliceState(f.db.client);
  assert.deepEqual(state.unconnected, [item]);
  assert.match(String(gateRefusal(state)), /turn --stage connect/);
  const blocked = await apply(f, { stage: "intake", chain: false });
  assert.equal(blocked.runs[0]?.row?.outcome, "refused");
  assert.match(String(blocked.runs[0]?.row?.reason), /THE GATE/);
  assert.equal(f.db.rows("intelligence_items").length, 1, "nothing new was minted");

  // The connect stage reads the backlog from harness_runs (never a directory) and connects it.
  const closed = await apply(f, { stage: "connect", chain: false });
  const row = closed.runs[0]?.row;
  assert.equal(row?.outcome, "success");
  assert.deepEqual((row?.outputs as { ids: { connected_item_ids: string[] } }).ids.connected_item_ids, [item]);
  assert.deepEqual((await readSliceState(f.db.client)).unconnected, []);
  const again = await apply(f, { stage: "intake", chain: false });
  assert.notEqual(again.runs[0]?.row?.outcome, "refused", "the gate is open once the slice is connected");
});

test("INV-195: a slice whose ids are gone refuses in intake AND connect; it is never connected with a zero outcome", async () => {
  const f = fixture();
  f.db.seed("harness_runs", [{ id: "e0000000-0000-4000-8000-000000000001", family: "ledger-consume", root_run_id: "e0000000-0000-4000-8000-000000000001", upstream_run_id: null, trigger: "dispatch", mode: "apply", forced_dry: false, outcome: "success", reason: null, inputs: {}, outputs: { counts: { minted: 2 }, ids: {} }, error: null, code_sha: null, github_run_id: null, started_at: NOW.toISOString(), finished_at: NOW.toISOString() }]);
  const mint = await apply(f, { stage: "intake", chain: false });
  assert.equal(mint.runs[0]?.row?.outcome, "refused");
  assert.match(String(mint.runs[0]?.row?.reason), /carry no recoverable ids/);
  const connect = await apply(f, { stage: "connect", chain: false });
  assert.equal(connect.runs[0]?.row?.outcome, "refused");
  assert.match(String(connect.runs[0]?.row?.reason), /never connected with a zero outcome/);
  assert.equal(f.db.rows("harness_runs").filter((x) => x.family === "corpus-turn" && x.outcome === "success").length, 0);
});

test("a dry run never trips the gate and never reads it as connected: THE GATE reads only apply rows", async () => {
  const f = fixture();
  capture(f);
  await runTurn({ stage: "intake", mode: "dry", chain: false, input }, { d: f.d, env: {}, now: () => NOW });
  assert.deepEqual(await readSliceState(f.db.client), { unconnected: [], unrecoverable: [] });
});
