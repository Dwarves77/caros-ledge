// `node scripts/runs/execute.mjs <plan.json>...`: runs the steps of each committed plan IN ORDER, every one as the turn job would (scripts/turn.mjs --stage --mode --input), stops at the first failure,
// writes scripts/runs/results/<plan>.json (step, outcome, ledger row ids, counts, refusals: a workflow artifact, never committed) and the per-step table to the job summary.
// Idempotence is in the ledger (INV-RUN-3): every step's stage input carries ruled_plan "<plan file>#<step>", which the harness records on the run row; a step with a success apply row for that key is skipped, a failed one runs again. A step may carry on_failure "continue" (default "stop"): its failure is recorded and the plan goes on.
// Nothing here bypasses the turn: the emergency stop, the licence register and the producers' own gates bind inside scripts/turn.mjs; a step the stop forced dry is a failure, never a pass.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { isMain } from "../lib/fs.mjs";

const pairs = (list) => Object.fromEntries(list.map((p) => p.split("=")));

/** The ledger question, over `sb` (the turn's own service client): the id of a success apply run row that recorded this ruled_plan key, or null. An unreadable ledger throws: it never reads as "not applied". */
export const ledgerLookup = (sb) => async (key) => {
  const { data, error } = await sb.from("harness_runs").select("id").eq("mode", "apply").eq("outcome", "success").eq("inputs->>ruled_plan", key).limit(1);
  if (error) throw new Error(`ruled-run ledger unreadable (${error.message}): refusing to guess which steps were applied`);
  return data?.[0]?.id ?? null;
};

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

/** An apply row that did not write because the run was refused (a gate said REFUSING: no key, kill switch off, licence, byte-limited read), whatever outcome the ledger gave it (a producer refusal is recorded as a noop). A dry row never writes, so it is never this. */
const refusedApply = (r) => r.mode !== "dry" && (r.outcome === "refused" || /REFUSING/.test(String(r.reason ?? "")));

/** What a step reports: its rows (family, ledger id, mode, outcome, counts) and the refusals they carry. A step with a refused apply row is `refused`, never `ok`, and carries the reason. Pure. */
function summarise(step, out) {
  const rows = out.result?.runs ?? [];
  const forced = step.mode === "apply" && rows.some((r) => r.forced_dry);
  const refusals = rows.reduce((n, r) => n + (r.counts?.refused ?? 0) + (r.outcome === "refused" ? 1 : 0), 0);
  const refused = step.mode === "apply" ? rows.find(refusedApply) : undefined;
  // A step whose rows count failed units did not do what it was ruled to do, whatever exit code the turn gave it (HEAL-1b: two items failed and the step read ok).
  const failedUnits = step.mode === "apply" && rows.some((r) => (r.counts?.failed ?? 0) > 0);
  // DRAIN-FIX-2 D2: a row whose own turn outcome is partial (residue, a failed downstream, a read-back miss) is partial too: DRAIN-1's item step was partial in the ledger and `ok` in the table.
  const partialRow = step.mode === "apply" && rows.some((r) => r.outcome === "partial");
  const outcome = out.status !== 0 ? "failed" : forced ? "forced-dry" : refused ? "refused" : failedUnits || partialRow ? "partial" : "ok";
  return { step: step.name, stage: step.stage, mode: step.mode, outcome, exit: out.status, root_run_id: out.result?.root_run_id ?? null, refusals, rows, ...(outcome === "refused" ? { note: String(refused.reason ?? refused.outcome) } : {}), ...(outcome === "partial" ? { note: failedUnits ? `${rows.reduce((n, r) => n + (r.counts?.failed ?? 0), 0)} unit(s) failed` : "the turn's outcome is partial" } : {}), ...(out.error ? { error: out.error } : {}) };
}

/** Runs `plan` (already parsed) step by step. `invoke({args, env})` is the turn call and `applied(key)` the ledger question; both are injected so a test starts no process and reads no database. */
export async function executePlan(plan, planPath, { invoke = invokeTurn, applied = async () => null, now = () => new Date() } = {}) {
  const results = { plan: basename(planPath, ".json"), ruling: plan.ruling, started_at: now().toISOString(), outcome: "ok", steps: [] };
  for (const step of plan.steps) {
    const key = `${basename(planPath)}#${step.name}`;
    const row = step.mode === "apply" ? await applied(key) : null;
    if (row) {
      results.steps.push({ step: step.name, stage: step.stage, mode: step.mode, outcome: "already-applied", note: `already applied (${row})` });
      continue;
    }
    const input = { ...step.input, [step.stage]: { ...step.input[step.stage], ruled_plan: key } };
    // A step that names an input_file hands the turn a temp file (the input with ruled_plan merged in), never an argv string: a large batch overruns the 128 KB argument limit.
    let inputArgs = ["--input", JSON.stringify(input)];
    if (step.input_file !== undefined) {
      const file = join(mkdtempSync(join(tmpdir(), "ruled-input-")), "input.json");
      writeFileSync(file, JSON.stringify(input));
      inputArgs = ["--input-file", file];
    }
    const args = ["scripts/turn.mjs", "--stage", step.stage, "--mode", step.mode, ...inputArgs, ...(step.chain ? [] : ["--no-chain"])];
    const done = summarise(step, invoke({ args, env: { ...pairs(step.producer_env), TURN_RULED_PLAN: planPath } }));
    // A partial outcome follows on_failure like any failure unless the step rules it acceptable (allow_partial): it is still reported as partial.
    const bad = done.outcome !== "ok" && !(done.outcome === "partial" && step.allow_partial === true);
    if (bad && step.on_failure === "continue") {
      results.steps.push({ ...done, continued: true });
      results.outcome = "partial";
      continue;
    }
    results.steps.push(done);
    if (bad) {
      results.outcome = "failed";
      break;
    }
  }
  return { ...results, finished_at: now().toISOString() };
}

/** The job's exit code: 1 only when a stop step failed. A continue step's failure is in the ledger and the summary, and the next push of the plan retries it (it has no success row). */
export const exitCodeOf = (results) => (results.outcome === "failed" ? 1 : 0);

/** The per-step table of the job summary, the failed steps first. */
export function summaryTable(results) {
  const failed = (s) => s.outcome !== "ok" && s.outcome !== "already-applied";
  const steps = [...results.steps.filter(failed), ...results.steps.filter((s) => !failed(s))];
  const note = (s) => `${s.continued ? "continued (on_failure continue); " : ""}${String(s.note ?? s.error ?? "")}`.replace(/\|/g, "/");
  return [`### Ruled run ${results.plan}: ${results.outcome}`, "", `ruling: ${results.ruling}`, "", "| step | mode | outcome | root run | refusals | note |", "|---|---|---|---|---|---|", ...steps.map((s) => `| ${s.step} | ${s.mode} | ${s.outcome} | ${s.root_run_id ?? "-"} | ${s.refusals ?? "-"} | ${note(s)} |`)].join("\n");
}

if (isMain(import.meta.url)) {
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { parsePlan } = await import("./plan.mjs");
  const { serviceClient } = await import("../../src/core/db/index.ts");
  const applied = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? ledgerLookup(serviceClient()) : undefined;
  let failed = false;
  for (const path of process.argv.slice(2)) {
    if (failed) break;
    const results = await executePlan(parsePlan(readFileSync(path, "utf8"), path), path, { applied });
    mkdirSync("scripts/runs/results", { recursive: true });
    writeFileSync(`scripts/runs/results/${results.plan}.json`, `${JSON.stringify(results, null, 2)}\n`);
    const table = summaryTable(results);
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
    failed = exitCodeOf(results) !== 0;
  }
  process.exit(failed ? 1 : 0);
}
