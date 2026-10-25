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
  for (const input of [{ propagate: { producers: { only: "ecb-fx" } } }, { propagate: { cadence_exception: "  ", producers: {} } }, { propagate: { cadence_exception: "another ruling" } }, {}]) {
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
