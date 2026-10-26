// RUN-1: the plan validator. INV-RUN-1: an apply step of the propagate stage without the ruling's cadence_exception is refused.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { STAGES } from "@/core/turn";

// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";

const RULING = "operator test ruling";
const step = (over: Record<string, unknown> = {}) => ({ name: "s", stage: "propagate", mode: "apply", input: { propagate: { producers: { only: "ecb-fx" }, cadence_exception: RULING } }, producer_env: ["MARKET_PRODUCER_ECB_FX_ENABLED=1"], ...over });
const plan = (over: Record<string, unknown> = {}) => JSON.stringify({ ruling: RULING, steps: [step()], ...over });

test("a well-formed plan parses; chain defaults to false", () => {
  const p = parsePlan(plan());
  assert.equal(p.steps[0].chain, false);
});

test("a plan may carry an integer revision of 2 or more (FIX-EDGES-1: the re-run marker); a fractional, zero or one revision is refused", () => {
  assert.equal(parsePlan(plan({ revision: 2 })).revision, 2);
  assert.equal(parsePlan(plan()).revision, undefined);
  for (const bad of [0, 1, 2.5, "2"]) assert.throws(() => parsePlan(plan({ revision: bad })), /revision|Invalid/, String(bad));
});

test("INV-RUN-1: an apply propagate step without the ruling's cadence_exception is refused (absent, blank, or any other text); a dry step and a non-propagate apply step need none", () => {
  for (const input of [{ propagate: { producers: { only: "ecb-fx" } } }, { propagate: { cadence_exception: "  ", producers: {} } }, { propagate: { cadence_exception: "another ruling", producers: {} } }, { propagate: { producers: {} } }]) {
    assert.throws(() => parsePlan(plan({ steps: [step({ input })] })), /cadence_exception/, JSON.stringify(input));
  }
  parsePlan(plan({ steps: [step({ mode: "dry", input: { propagate: { producers: { only: "ecb-fx" } } }, producer_env: [] })] }));
  parsePlan(plan({ steps: [step({ stage: "connect", input: { connect: { corpus: true } }, producer_env: [] })] }));
});

test("the plan is refused for a missing or blank ruling, a bad producer_env, an unknown stage, a bad mode, no steps, a leftover applied flag, an unknown key", () => {
  assert.throws(() => parsePlan(JSON.stringify({ steps: [step()] })), /ruling/);
  assert.throws(() => parsePlan(plan({ ruling: "" })), /ruling/);
  assert.throws(() => parsePlan(plan({ ruling: " padded " })), /ruling/);
  for (const bad of ["SUPABASE_SERVICE_ROLE_KEY=1", "A_ENABLED=0", "a_ENABLED=1", "A_ENABLED=1\nB=2"]) assert.throws(() => parsePlan(plan({ steps: [step({ producer_env: [bad] })] })), /producer_env|Invalid/, bad);
  assert.throws(() => parsePlan(plan({ steps: [step({ stage: "nope" })] })), /stage/);
  assert.throws(() => parsePlan(plan({ steps: [step({ mode: "force" })] })), /mode/);
  assert.throws(() => parsePlan(plan({ steps: [] })));
  assert.throws(() => parsePlan(plan({ applied: false })), "the applied flag no longer exists");
  assert.throws(() => parsePlan(plan({ extra: 1 })));
});

test("every stage the turn has is accepted", () => {
  for (const stage of STAGES) if (stage !== "propagate") parsePlan(plan({ steps: [step({ stage, input: {}, producer_env: [] })] }));
});

test("the first plan (ARM-1) parses: a dry ecb-fx step first, every propagate apply step carrying the ruling", () => {
  const p = parsePlan(readFileSync("scripts/runs/plans/2026-10-24-arm-1.json", "utf8"));
  assert.deepEqual([p.steps[0].name, p.steps[0].mode], ["ecb-fx-dry", "dry"]);
  assert.ok(p.steps.some((s: { mode: string }) => s.mode === "apply"));
  assert.equal(new Set(p.steps.map((s: { name: string }) => s.name)).size, p.steps.length, "step names are unique");
});

test("the ARM-2 plan (2026-10-25-arm-2) parses: six steps, dry then apply for statutory-schedules, reroute-rows and state-cost-facts", () => {
  const p = parsePlan(readFileSync("scripts/runs/plans/2026-10-25-arm-2.json", "utf8"));
  assert.equal(p.steps.length, 6);
  assert.deepEqual(
    p.steps.map((s: { mode: string }) => s.mode),
    ["dry", "apply", "dry", "apply", "dry", "apply"],
  );
});

test("every plan file under scripts/runs/plans parses, so a malformed plan is red in its pull request and not on main", () => {
  for (const f of readdirSync("scripts/runs/plans").filter((n) => n.endsWith(".json"))) parsePlan(readFileSync(`scripts/runs/plans/${f}`, "utf8"));
});

test("a producers.only that is not an entry of the registry is refused (a typo would run nothing); every registry name is accepted", () => {
  const input = (only: string) => ({ propagate: { producers: { only }, cadence_exception: RULING } });
  assert.throws(() => parsePlan(plan({ steps: [step({ input: input("ecb-fxx") })] })), /ecb-fxx.*registry.json/);
  assert.throws(() => parsePlan(plan({ steps: [step({ mode: "dry", input: input("nope"), producer_env: [] })] })), /registry.json/);
  parsePlan(plan({ steps: [step({ input: input("ecb-fx") })] }));
});

test("the ruling's cadence_exception is required on an apply propagate step that fetches (its input carries `producers`) and refused as a false claim on an apply step that fetches nothing (a derive or retokenise pass, a connect step)", () => {
  // Steps that fetch nothing need none.
  parsePlan(plan({ steps: [step({ input: { propagate: { derive: { only: "x" } } }, producer_env: [] })] }));
  parsePlan(plan({ steps: [step({ input: {}, producer_env: [] })] }));
  parsePlan(plan({ steps: [step({ stage: "connect", input: { connect: { corpus: true } }, producer_env: [] })] }));
  // The seed pages the coupling step captures are a fetch of an apply propagate step with no producers: the ruling may ride there, and only the plan's own text.
  parsePlan(plan({ steps: [step({ input: { propagate: { cadence_exception: RULING } }, producer_env: [] })] }));
  assert.throws(() => parsePlan(plan({ steps: [step({ input: { propagate: { cadence_exception: "another ruling" } }, producer_env: [] })] })), /cadence_exception.*equal/);
  // A cadence_exception on a step that fetches nothing claims an exception it cannot use.
  for (const s of [step({ stage: "connect", input: { connect: { cadence_exception: RULING } }, producer_env: [] })]) {
    assert.throws(() => parsePlan(plan({ steps: [s] })), /cadence_exception.*(fetch|false)/i, JSON.stringify(s.input));
  }
  // The steps that fetch still need the ruling.
  assert.throws(() => parsePlan(plan({ steps: [step({ input: { propagate: { producers: { only: "ecb-fx" } } } })] })), /cadence_exception/);
});

test("the CONNECT-2A plan parses: couplings and patterns, dry then apply, the ruling on the apply propagate step that captures the seed pages", () => {
  const p = parsePlan(readFileSync("scripts/runs/plans/2026-10-26-connect-2a.json", "utf8"));
  assert.deepEqual(p.steps.map((s: { name: string }) => s.name), ["couplings-dry", "couplings-apply", "patterns-dry", "patterns-apply"]);
  assert.deepEqual(p.steps.map((s: { stage: string }) => s.stage), ["propagate", "propagate", "connect", "connect"]);
  assert.ok(p.steps.every((s: { producer_env: string[]; input: Record<string, { producers?: unknown }> }) => s.producer_env.length === 0 && s.input.propagate?.producers === undefined), "no producer runs in this plan");
  assert.equal(p.steps[1].input.propagate.cadence_exception, p.ruling);
});

test("HEAL-1: an operator task is ruled as a stage `ops` step whose input names an op of the turn's ops table; an unknown op, and an `ops` input on another stage, are refused", () => {
  const ops = (over: Record<string, unknown> = {}) => step({ name: "heal", stage: "ops", mode: "dry", input: { ops: { op: "heal-quarantined", args: { selection: "ids", ids: ["a"] } } }, producer_env: [], ...over });
  const p = parsePlan(plan({ steps: [ops(), ops({ name: "heal-apply", mode: "apply" })] }));
  assert.deepEqual(p.steps.map((s: { stage: string }) => s.stage), ["ops", "ops"]);
  assert.throws(() => parsePlan(plan({ steps: [ops({ input: { ops: { op: "heal-everything" } } })] })), /not an op/);
  assert.throws(() => parsePlan(plan({ steps: [ops({ input: {} })] })), /not an op/);
  assert.throws(() => parsePlan(plan({ steps: [ops({ stage: "connect", input: { ops: { op: "heal-quarantined" } } })] })), /input.ops belongs to a stage/);
  assert.throws(() => parsePlan(plan({ steps: [ops({ mode: "apply", input: { ops: { op: "heal-quarantined", cadence_exception: RULING } } })] })), /false claim/);
});

test("HEAL-1: the heal plan (2026-10-26-heal-1) heals exactly the two ruled instrument items from stored captures: a dry step then an apply step of heal-quarantined over their ids, nothing that fetches", () => {
  const p = parsePlan(readFileSync("scripts/runs/plans/2026-10-26-heal-1.json", "utf8"));
  assert.equal(p.revision, 3, "the re-run marker: heal-apply has no success row, and the changed file starts the job");
  assert.deepEqual(p.steps.map((s: { mode: string }) => s.mode), ["dry", "apply"]);
  for (const s of p.steps) {
    assert.equal(s.stage, "ops");
    assert.deepEqual(s.input.ops.args.ids, ["7a0ead55-7a7b-403b-8ba3-33862cb296e2", "15f63ea9-4803-4bb4-b1a3-9ccdeb8a3050"]);
    assert.equal(s.input.ops.args.selection, "ids");
    assert.equal(s.input.ops.args.stripUnprovable, true, "revision 2: the honest strip of the sentences no capture states (ruling 2026-10-26)");
    assert.deepEqual(s.producer_env, []);
  }
});

// DRAIN-1: a step's input is inline (under 100,000 bytes) or a data file beside the plan (input_file), exactly one.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const planDir = () => {
  const d = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(d, "data"));
  writeFileSync(join(d, "data", "in.json"), JSON.stringify({ connect: { scan_limit: 0 } }));
  return d;
};
const fileStep = (over: Record<string, unknown> = {}) => ({ name: "f", stage: "connect", mode: "dry", input_file: "data/in.json", producer_env: [], ...over });

test("DRAIN-1: an inline input over 100,000 bytes is refused, naming the step and input_file", () => {
  const big = { connect: { blob: "x".repeat(100_001) } };
  assert.throws(() => parsePlan(plan({ steps: [step({ name: "huge", stage: "connect", mode: "dry", input: big, producer_env: [] })] })), /huge[\s\S]*input_file|input_file[\s\S]*huge/);
  parsePlan(plan({ steps: [step({ stage: "connect", mode: "dry", input: { connect: { blob: "x".repeat(90_000) } }, producer_env: [] })] }));
});

test("DRAIN-1: input and input_file together, or neither, are refused", () => {
  const d = planDir();
  const p = join(d, "p.json");
  assert.throws(() => parsePlan(plan({ steps: [fileStep({ input: {} })] }), p), /input_file/);
  assert.throws(() => parsePlan(plan({ steps: [fileStep({ input_file: undefined })] }), p), /input/);
});

test("DRAIN-1: an input_file that escapes the plan's directory (.., absolute) is refused", () => {
  const d = planDir();
  const p = join(d, "p.json");
  for (const bad of ["../x.json", "data/../../x.json", join(d, "data", "in.json"), "/etc/passwd"]) assert.throws(() => parsePlan(plan({ steps: [fileStep({ input_file: bad })] }), p), /input_file|escape/, bad);
});

test("DRAIN-1: input_file is loaded relative to the plan and becomes the step's input; a missing file is refused", () => {
  const d = planDir();
  const p = join(d, "p.json");
  const s = parsePlan(plan({ steps: [fileStep()] }), p).steps[0];
  assert.deepEqual(s.input, { connect: { scan_limit: 0 } });
  assert.equal(s.input_file, "data/in.json");
  assert.throws(() => parsePlan(plan({ steps: [fileStep({ input_file: "data/none.json" })] }), p), /none\.json/);
});
