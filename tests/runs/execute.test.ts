// RUN-1: the executor with the turn call replaced. INV-RUN-2: a step's producer_env reaches that step's turn call only. INV-RUN-3: an applied plan runs nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { executePlan } from "../../scripts/runs/execute.mjs";
// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";

type Call = { args: string[]; env: Record<string, string>; seen: Record<string, string | undefined> };
const RULING = "operator test ruling";
const KEYS = ["A_ENABLED", "B_ENABLED", "C_ENABLED"];
const mk = (names: string[], over: Record<string, unknown> = {}) =>
  parsePlan(JSON.stringify({ ruling: RULING, applied: false, steps: names.map((n) => ({ name: n, stage: "propagate", mode: "apply", input: { propagate: { producers: { only: n }, cadence_exception: RULING } }, producer_env: [`${n.toUpperCase()}_ENABLED=1`] })), ...over }));
/** A turn call that records what it was given and the process environment at that moment; `fail` names the step whose turn exits 1. */
function turn(fail = "", row: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const invoke = ({ args, env }: { args: string[]; env: Record<string, string> }) => {
    calls.push({ args, env, seen: Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) });
    const only = JSON.parse(args[args.indexOf("--input") + 1] as string).propagate.producers.only;
    return { status: only === fail ? 1 : 0, result: { root_run_id: `root-${only}`, runs: [{ family: "propagation", id: `row-${only}`, mode: "apply", outcome: "success", counts: { refused: 1 }, ...row }] } };
  };
  return { calls, invoke };
}
const NOW = () => new Date("2026-10-24T00:00:00Z");
const PATH = "scripts/runs/plans/2026-10-24-x.json";
const onlyOf = (c: Call) => JSON.parse(c.args[c.args.indexOf("--input") + 1] as string).propagate.producers.only;

test("the steps run in order, each as the turn is called by hand (stage, mode, input, no-chain)", async () => {
  const t = turn();
  const r = await executePlan(mk(["a", "b", "c"]), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual(t.calls.map(onlyOf), ["a", "b", "c"]);
  assert.deepEqual(t.calls[0]!.args.slice(0, 6), ["scripts/turn.mjs", "--stage", "propagate", "--mode", "apply", "--input"]);
  assert.ok(t.calls[0]!.args.includes("--no-chain"));
  assert.equal(r.outcome, "ok");
});

test("it stops at the first failure: later steps never run and the result says which failed", async () => {
  const t = turn("b");
  const r = await executePlan(mk(["a", "b", "c"]), PATH, { invoke: t.invoke, now: NOW });
  assert.equal(t.calls.length, 2);
  assert.deepEqual(r.steps.map((s: { step: string; outcome: string }) => [s.step, s.outcome]), [["a", "ok"], ["b", "failed"]]);
  assert.equal(r.outcome, "failed");
});

test("an apply step the run frame forced dry (the emergency stop) is a failure, not a pass", async () => {
  const t = turn("", { forced_dry: true, mode: "dry" });
  const r = await executePlan(mk(["a", "b"]), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual([t.calls.length, r.steps[0].outcome, r.outcome], [1, "forced-dry", "failed"]);
});

test("the results file shape: plan, ruling, outcome, times, and per step the ledger row ids, counts and refusals", async () => {
  const r = await executePlan(mk(["a"]), PATH, { invoke: turn().invoke, now: NOW });
  assert.deepEqual(r, {
    plan: "2026-10-24-x", ruling: RULING, started_at: "2026-10-24T00:00:00.000Z", finished_at: "2026-10-24T00:00:00.000Z", outcome: "ok",
    steps: [{ step: "a", stage: "propagate", mode: "apply", outcome: "ok", exit: 0, root_run_id: "root-a", refusals: 1, rows: [{ family: "propagation", id: "row-a", mode: "apply", outcome: "success", counts: { refused: 1 } }] }],
  });
});

test("INV-RUN-2: producer_env reaches its own step's turn call only; the executor's own environment never holds it, before, during or after", async () => {
  const t = turn();
  await executePlan(mk(["a", "b", "c"]), PATH, { invoke: t.invoke, now: NOW });
  const own = (c: Call) => Object.keys(c.env).filter((k) => KEYS.includes(k));
  assert.deepEqual(t.calls.map(own), [["A_ENABLED"], ["B_ENABLED"], ["C_ENABLED"]]);
  assert.deepEqual(t.calls.map((c) => c.env.TURN_RULED_PLAN), [PATH, PATH, PATH]);
  assert.ok(t.calls.every((c) => KEYS.every((k) => c.seen[k] === undefined)), "not in process.env during any call");
  assert.deepEqual(KEYS.map((k) => process.env[k]), [undefined, undefined, undefined]);
});

test("INV-RUN-2: a failing step also clears its producer_env", async () => {
  await executePlan(mk(["a", "b"]), PATH, { invoke: turn("a").invoke, now: NOW });
  assert.equal(process.env.A_ENABLED, undefined);
});

test("INV-RUN-3: a plan already applied runs nothing", async () => {
  const t = turn();
  const r = await executePlan(mk(["a"], { applied: true }), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual([t.calls.length, r.outcome, r.steps], [0, "skipped", []]);
});
