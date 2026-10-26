// RUN-1: the executor with the turn call replaced. INV-RUN-2: a step's producer_env reaches that step's turn call only. INV-RUN-3: a step with a success apply row in the ledger is skipped.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { executePlan, exitCodeOf, ledgerLookup, summaryTable } from "../../scripts/runs/execute.mjs";
// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";

type Call = { args: string[]; env: Record<string, string>; seen: Record<string, string | undefined> };
const RULING = "operator test ruling";
const REAL: Record<string, string> = { a: "ecb-fx", b: "eia-v2-petroleum-spot", c: "bls-oews" };
const KEYS = ["A_ENABLED", "B_ENABLED", "C_ENABLED"];
const mk = (names: string[], over: Record<string, unknown> = {}) =>
  parsePlan(JSON.stringify({ ruling: RULING, steps: names.map((n) => ({ name: n, stage: "propagate", mode: "apply", input: { propagate: { producers: { only: REAL[n] }, cadence_exception: RULING } }, producer_env: [`${n.toUpperCase()}_ENABLED=1`] })), ...over }));
/** The step name a turn call is for, read from the ruled_plan key the executor puts in the stage input. */
const stepOf = (args: string[]): string => JSON.parse(args[args.indexOf("--input") + 1] as string).propagate.ruled_plan.split("#")[1];
/** A turn call that records what it was given and the process environment at that moment; `fail` names the step whose turn exits 1. */
function turn(fail = "", row: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const invoke = ({ args, env }: { args: string[]; env: Record<string, string> }) => {
    calls.push({ args, env, seen: Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) });
    const only = stepOf(args);
    return { status: only === fail ? 1 : 0, result: { root_run_id: `root-${only}`, runs: [{ family: "propagation", id: `row-${only}`, mode: "apply", outcome: "success", counts: { refused: 1 }, ...row }] } };
  };
  return { calls, invoke };
}
const NOW = () => new Date("2026-10-24T00:00:00Z");
const PATH = "scripts/runs/plans/2026-10-24-x.json";
const onlyOf = (c: Call) => stepOf(c.args);

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

const ONLY_A = async (key: string) => (key === "2026-10-24-x.json#a" ? "row-9" : null);

test("INV-RUN-3: a step whose ledger already holds a success apply row is skipped and reported (already applied, with the row id); the rest run, each carrying its own ruled_plan key in the stage input", async () => {
  const t = turn();
  const r = await executePlan(mk(["a", "b"]), PATH, { invoke: t.invoke, now: NOW, applied: ONLY_A });
  assert.deepEqual(t.calls.map(onlyOf), ["b"]);
  assert.equal(JSON.parse(t.calls[0]!.args[t.calls[0]!.args.indexOf("--input") + 1] as string).propagate.ruled_plan, "2026-10-24-x.json#b");
  assert.deepEqual(r.steps.map((s: { step: string; outcome: string }) => [s.step, s.outcome]), [["a", "already-applied"], ["b", "ok"]]);
  assert.equal(r.steps[0].note, "already applied (row-9)");
  assert.equal(r.outcome, "ok");
});

test("INV-RUN-3: with every step applied the plan runs nothing; a step the ledger does not hold (a failed one) is run again", async () => {
  const t = turn();
  const all = await executePlan(mk(["a", "b"]), PATH, { invoke: t.invoke, now: NOW, applied: async () => "row-1" });
  assert.deepEqual([t.calls.length, all.outcome], [0, "ok"]);
  await executePlan(mk(["a"]), PATH, { invoke: t.invoke, now: NOW, applied: async () => null });
  assert.equal(t.calls.length, 1);
});

/** A client that records the filters of the one query the lookup makes. */
function fake(result: { data: { id: string }[] | null; error: { message: string } | null }) {
  const eqs: [string, string][] = [];
  const q = { select: () => q, eq: (c: string, v: string) => (eqs.push([c, v]), q), limit: () => Promise.resolve(result) };
  return { eqs, sb: { from: (t: string) => (eqs.push(["from", t]), q) } };
}

test("the ledger lookup asks harness_runs for an apply-mode success row with this ruled_plan key; an unreadable ledger throws and never reads as not applied", async () => {
  const hit = fake({ data: [{ id: "row-3" }], error: null });
  assert.equal(await ledgerLookup(hit.sb)("p.json#s"), "row-3");
  assert.deepEqual(hit.eqs, [["from", "harness_runs"], ["mode", "apply"], ["outcome", "success"], ["inputs->>ruled_plan", "p.json#s"]]);
  assert.equal(await ledgerLookup(fake({ data: [], error: null }).sb)("p.json#s"), null);
  await assert.rejects(() => ledgerLookup(fake({ data: null, error: { message: "boom" } }).sb)("p.json#s"), /boom/);
});

const mkOn = (modes: Record<string, string>) => {
  const plan = JSON.parse(JSON.stringify(mk(["a", "b", "c"])));
  for (const st of plan.steps) if (modes[st.name]) st.on_failure = modes[st.name];
  return parsePlan(JSON.stringify(plan));
};

test("on_failure: a plan step defaults to stop; the value is validated", () => {
  assert.equal(mk(["a"]).steps[0].on_failure, "stop");
  assert.throws(() => mkOn({ a: "shrug" }), /on_failure/);
});

test("on_failure continue: a failed continue step is recorded, the next steps run, the job exits 0, and the summary lists the failed step first", async () => {
  const t = turn("a");
  const r = await executePlan(mkOn({ a: "continue" }), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual(t.calls.map(onlyOf), ["a", "b", "c"]);
  assert.deepEqual(r.steps.map((s: { step: string; outcome: string }) => [s.step, s.outcome]), [["a", "failed"], ["b", "ok"], ["c", "ok"]]);
  assert.equal(r.outcome, "partial");
  assert.equal(exitCodeOf(r), 0);
  const rows = summaryTable(r).split("\n").filter((l: string) => l.startsWith("| ") && !l.startsWith("| step") && !l.startsWith("|---"));
  assert.match(rows[0], /^\| a \|.*failed/);
  assert.match(summaryTable(r), /continued/);
});

test("on_failure stop: a failed stop step halts the plan and the job exits 1, even after an earlier continue failure", async () => {
  const t = turn("b");
  const r = await executePlan(mkOn({ a: "continue" }), PATH, { invoke: turn("a").invoke, now: NOW });
  assert.equal(exitCodeOf(r), 0);
  const r2 = await executePlan(mkOn({ a: "continue" }), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual(t.calls.map(onlyOf), ["a", "b"]);
  assert.equal(r2.outcome, "failed");
  assert.equal(exitCodeOf(r2), 1);
  const both = turn("a");
  const r3 = await executePlan(mkOn({ a: "continue", b: "stop" }), PATH, { invoke: (x: never) => { const o = both.invoke(x); return stepOf((x as { args: string[] }).args) === "b" ? { ...o, status: 1 } : o; }, now: NOW });
  assert.equal(exitCodeOf(r3), 1);
});

test("on_failure continue: a continue step whose ledger holds a success row is still skipped", async () => {
  const t = turn();
  const r = await executePlan(mkOn({ a: "continue" }), PATH, { invoke: t.invoke, now: NOW, applied: ONLY_A });
  assert.deepEqual(t.calls.map(onlyOf), ["b", "c"]);
  assert.equal(r.steps[0].outcome, "already-applied");
  assert.equal(r.outcome, "ok");
});

/** A turn whose exit is 0 for every step but whose ledger row for `refusing` is a noop that says REFUSING (a producer the gates would not let write: no key, kill switch off, licence). */
function refusing(name: string, mode: "apply" | "dry" = "apply") {
  const t = turn();
  const invoke = (x: { args: string[]; env: Record<string, string> }) => {
    const o = t.invoke(x);
    return stepOf(x.args) === name ? { ...o, result: { ...o.result, runs: [{ family: "propagation", id: `row-${name}`, mode, outcome: "noop", reason: `${REAL[name]}: REFUSING: apply requires database credentials and any declared key; none found`, counts: {} }] } } : o;
  };
  return { calls: t.calls, invoke };
}

test("a step whose ledger outcome is a noop that says REFUSING is reported refused, not ok, with the reason in the note; it is a failure for the plan like any other", async () => {
  const t = refusing("b");
  const r = await executePlan(mk(["a", "b", "c"]), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual(r.steps.map((s: { step: string; outcome: string }) => [s.step, s.outcome]), [["a", "ok"], ["b", "refused"]]);
  assert.match(r.steps[1].note, /REFUSING: apply requires database credentials/);
  assert.deepEqual([t.calls.length, r.outcome, exitCodeOf(r)], [2, "failed", 1], "a stop step that was refused halts the plan");
  assert.match(summaryTable(r).split("\n").find((l: string) => l.startsWith("| b |")) ?? "", /\| refused \|.*REFUSING/);
});

test("a refused continue step: the plan goes on, the outcome is partial, the job exits 0, and the table lists the step first as refused (continued)", async () => {
  const t = refusing("b");
  const r = await executePlan(mkOn({ b: "continue" }), PATH, { invoke: t.invoke, now: NOW });
  assert.deepEqual(t.calls.map(onlyOf), ["a", "b", "c"]);
  assert.deepEqual(r.steps.map((s: { step: string; outcome: string }) => s.outcome), ["ok", "refused", "ok"]);
  assert.deepEqual([r.outcome, exitCodeOf(r)], ["partial", 0]);
  const rows = summaryTable(r).split("\n").filter((l: string) => l.startsWith("| ") && !l.startsWith("| step") && !l.startsWith("|---"));
  assert.match(rows[0], /^\| b \|.*refused.*continued/);
});

test("a ledger row with outcome refused is refused too; a dry step that says REFUSING, and an apply step whose rows were refused one by one (counts.refused), are not", async () => {
  const outcomeRefused = async (outcome: string, mode: "apply" | "dry", counts: Record<string, number>) => {
    const t = turn("", { outcome, mode, counts, reason: outcome === "success" ? "3 rows refused one by one" : "REFUSING: x" });
    const plan = mk(["a"]);
    plan.steps[0].mode = mode;
    return (await executePlan(plan, PATH, { invoke: t.invoke, now: NOW })).steps[0].outcome;
  };
  assert.equal(await outcomeRefused("refused", "apply", {}), "refused");
  assert.equal(await outcomeRefused("noop", "dry", {}), "ok", "a dry run never writes, so a refusal to write is not its failure");
  assert.equal(await outcomeRefused("success", "apply", { refused: 3 }), "ok", "rows refused one by one are counted in refusals; the step still wrote");
});

test("HEAL-1: an ops step carries its ruled_plan key inside input.ops (the op's own args), so the ledger finds its success row by the same key", async () => {
  const seen: string[][] = [];
  const invoke = ({ args }: { args: string[] }) => {
    seen.push(args);
    return { status: 0, result: { root_run_id: "root", runs: [{ family: "ops", id: "row", mode: "apply", outcome: "success", counts: {} }] } };
  };
  const plan = parsePlan(JSON.stringify({ ruling: RULING, steps: [{ name: "heal", stage: "ops", mode: "apply", input: { ops: { op: "heal-quarantined", args: { selection: "ids", ids: ["x"] } } }, producer_env: [] }] }));
  await executePlan(plan, PATH, { invoke, now: NOW });
  assert.deepEqual(seen[0]!.slice(1, 5), ["--stage", "ops", "--mode", "apply"]);
  assert.deepEqual(JSON.parse(seen[0]![seen[0]!.indexOf("--input") + 1] as string), { ops: { op: "heal-quarantined", args: { selection: "ids", ids: ["x"] }, ruled_plan: "2026-10-24-x.json#heal" } });
});
