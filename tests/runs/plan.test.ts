// RUN-1: the plan validator. INV-RUN-1: an apply step of the propagate stage without the ruling's cadence_exception is refused.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { STAGES } from "@/core/turn";

// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";

const RULING = "operator test ruling";
const step = (over: Record<string, unknown> = {}) => ({ name: "s", stage: "propagate", mode: "apply", input: { propagate: { producers: { only: "ecb-fx" }, cadence_exception: RULING } }, producer_env: ["MARKET_PRODUCER_ECB_FX_ENABLED=1"], ...over });
const plan = (over: Record<string, unknown> = {}) => JSON.stringify({ ruling: RULING, applied: false, steps: [step()], ...over });

test("a well-formed plan parses; chain defaults to false", () => {
  const p = parsePlan(plan());
  assert.equal(p.steps[0].chain, false);
});

test("INV-RUN-1: an apply propagate step without the ruling's cadence_exception is refused (absent, blank, or any other text); a dry step and a non-propagate apply step need none", () => {
  for (const input of [{ propagate: { producers: { only: "ecb-fx" } } }, { propagate: { cadence_exception: "  ", producers: {} } }, { propagate: { cadence_exception: "another ruling" } }, {}]) {
    assert.throws(() => parsePlan(plan({ steps: [step({ input })] })), /cadence_exception/, JSON.stringify(input));
  }
  parsePlan(plan({ steps: [step({ mode: "dry", input: { propagate: { producers: { only: "ecb-fx" } } }, producer_env: [] })] }));
  parsePlan(plan({ steps: [step({ stage: "connect", input: { connect: { corpus: true } }, producer_env: [] })] }));
});

test("the plan is refused for a missing or blank ruling, a bad producer_env, an unknown stage, a bad mode, no steps, a missing applied flag, an unknown key", () => {
  assert.throws(() => parsePlan(JSON.stringify({ applied: false, steps: [step()] })), /ruling/);
  assert.throws(() => parsePlan(plan({ ruling: "" })), /ruling/);
  assert.throws(() => parsePlan(plan({ ruling: " padded " })), /ruling/);
  for (const bad of ["SUPABASE_SERVICE_ROLE_KEY=1", "A_ENABLED=0", "a_ENABLED=1", "A_ENABLED=1\nB=2"]) assert.throws(() => parsePlan(plan({ steps: [step({ producer_env: [bad] })] })), /producer_env|Invalid/, bad);
  assert.throws(() => parsePlan(plan({ steps: [step({ stage: "nope" })] })), /stage/);
  assert.throws(() => parsePlan(plan({ steps: [step({ mode: "force" })] })), /mode/);
  assert.throws(() => parsePlan(plan({ steps: [] })));
  assert.throws(() => parsePlan(JSON.stringify({ ruling: RULING, steps: [step()] })), /applied/);
  assert.throws(() => parsePlan(plan({ extra: 1 })));
});

test("every stage the turn has is accepted", () => {
  for (const stage of STAGES) if (stage !== "propagate") parsePlan(plan({ steps: [step({ stage, input: {}, producer_env: [] })] }));
});

test("the first plan (ARM-1) parses: not yet applied, a dry ecb-fx step first, every propagate apply step carrying the ruling", () => {
  const p = parsePlan(readFileSync("scripts/runs/plans/2026-10-24-arm-1.json", "utf8"));
  assert.equal(p.applied, false);
  assert.deepEqual([p.steps[0].name, p.steps[0].mode], ["ecb-fx-dry", "dry"]);
  assert.ok(p.steps.some((s: { mode: string }) => s.mode === "apply"));
  assert.equal(new Set(p.steps.map((s: { name: string }) => s.name)).size, p.steps.length, "step names are unique");
});

test("every plan file under scripts/runs/plans parses, so a malformed plan is red in its pull request and not on main", () => {
  for (const f of readdirSync("scripts/runs/plans").filter((n) => n.endsWith(".json"))) parsePlan(readFileSync(`scripts/runs/plans/${f}`, "utf8"));
});
