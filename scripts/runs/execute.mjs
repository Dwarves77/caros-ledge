// `node scripts/runs/execute.mjs <plan.json>...`: runs the steps of each committed plan IN ORDER, every one as the turn job would (scripts/turn.mjs --stage --mode --input), stops at the first failure,
// writes scripts/runs/results/<plan>.json (step, outcome, ledger row ids, counts, refusals) and, when every step succeeded, flips the plan's `applied` to true. An applied plan runs nothing (INV-RUN-3).
// Nothing here bypasses the turn: the emergency stop, the licence register and the producers' own gates bind inside scripts/turn.mjs; a step the stop forced dry is a failure, never a pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { isMain } from "../lib/fs.mjs";

const pairs = (list) => Object.fromEntries(list.map((p) => p.split("=")));

/** One turn invocation in a child process. `env` (the step's producer kill switches and the plan path) exists for this child alone. Returns the child's status and the result file turn.mjs wrote. */
export function invokeTurn({ args, env }) {
  const file = join(mkdtempSync(join(tmpdir(), "ruled-run-")), "turn.json");
  const r = spawnSync(process.execPath, args, { env: { ...process.env, ...env, TURN_RESULT_FILE: file }, stdio: "inherit" });
  try {
    return { status: r.status ?? 1, result: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { status: r.status ?? 1, result: null, error: `no turn result (the turn died before it wrote one): ${err.message}` }; // recorded on the step
  }
}

/** What a step reports: its rows (family, ledger id, mode, outcome, counts) and the refusals they carry. Pure. */
function summarise(step, out) {
  const rows = out.result?.runs ?? [];
  const forced = step.mode === "apply" && rows.some((r) => r.forced_dry);
  const refusals = rows.reduce((n, r) => n + (r.counts?.refused ?? 0) + (r.outcome === "refused" ? 1 : 0), 0);
  const outcome = out.status !== 0 ? "failed" : forced ? "forced-dry" : "ok";
  return { step: step.name, stage: step.stage, mode: step.mode, outcome, exit: out.status, root_run_id: out.result?.root_run_id ?? null, refusals, rows, ...(out.error ? { error: out.error } : {}) };
}

/** Runs `plan` (already parsed) step by step. `invoke({args, env})` is the turn call; it is injected so a test never starts a process. */
export async function executePlan(plan, planPath, { invoke = invokeTurn, now = () => new Date() } = {}) {
  const results = { plan: basename(planPath, ".json"), ruling: plan.ruling, started_at: now().toISOString(), outcome: "ok", steps: [] };
  if (plan.applied) return { ...results, outcome: "skipped", note: "already applied: nothing run" };
  for (const step of plan.steps) {
    const args = ["scripts/turn.mjs", "--stage", step.stage, "--mode", step.mode, "--input", JSON.stringify(step.input), ...(step.chain ? [] : ["--no-chain"])];
    const done = summarise(step, invoke({ args, env: { ...pairs(step.producer_env), TURN_RULED_PLAN: planPath } }));
    results.steps.push(done);
    if (done.outcome !== "ok") {
      results.outcome = "failed";
      break;
    }
  }
  return { ...results, finished_at: now().toISOString() };
}

if (isMain(import.meta.url)) {
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { parsePlan } = await import("./plan.mjs");
  let failed = false;
  for (const path of process.argv.slice(2)) {
    if (failed) break;
    const text = readFileSync(path, "utf8");
    const results = await executePlan(parsePlan(text), path);
    console.log(`runs: ${results.plan}: ${results.outcome}${results.note ? ` (${results.note})` : ""}`);
    if (results.outcome === "skipped") continue;
    mkdirSync("scripts/runs/results", { recursive: true });
    writeFileSync(`scripts/runs/results/${results.plan}.json`, `${JSON.stringify(results, null, 2)}\n`);
    if (results.outcome === "ok") writeFileSync(path, `${JSON.stringify({ ...JSON.parse(text), applied: true }, null, 2)}\n`);
    else failed = true;
  }
  process.exit(failed ? 1 : 0);
}
