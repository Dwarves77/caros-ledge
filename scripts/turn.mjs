// The ONE CLI. `node scripts/turn.mjs --stage <sweep|sweep-research|change|capture|intake|connect|propagate|briefs|all|ops> --mode dry|apply [--input '<json keyed by stage>' | --input-file <path>] [--no-chain]`
// Exit 0 every stage recorded and none failed; 1 a stage failed, a record failed, a credential is missing where the event could carry it, or the run is not a dispatch in CI; 2 self-skipped for lack of credentials where the event cannot carry them (src/core/harness/exit.ts:
// a workstation, or a fork PR). It never runs a turn on a push or a pull request: the workflow gives the turn job its secrets on a dispatch only. The one exception is a RULED run (scripts/runs/execute.mjs, TURN_RULED_PLAN
// set): the `ruled-runs` job runs a committed plan on a push to main, and only there; the run frame, the emergency stop and the licence register bind it exactly as a dispatch. TURN_RESULT_FILE: where to write the result as JSON.
// Apply is refused by the run frame while the scrape cadence is off (rule 16): a dispatch in build mode is always dry, and its rows say so.
import { appendFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

import { turnInputText } from "./lib/turn-input.mjs";

register("./lib/ts-hooks.mjs", import.meta.url, { data: {} });

const USAGE = "usage: node scripts/turn.mjs --stage <name|all|ops> --mode dry|apply [--input '<json keyed by stage>' | --input-file <path>] [--no-chain]";
const fail = (msg) => {
  console.error(`turn: ${msg}\n${USAGE}`);
  process.exit(1);
};
const note = (title, msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice title=${title}::${msg}` : `${title}: ${msg}`);

const { values } = parseArgs({ options: { stage: { type: "string" }, mode: { type: "string", default: "dry" }, input: { type: "string" }, "input-file": { type: "string" }, "no-chain": { type: "boolean", default: false } }, strict: true, allowPositionals: false });
let inputText;
try {
  inputText = turnInputText(values);
} catch (e) {
  fail(e.message);
}
const event = process.env.GITHUB_EVENT_NAME;
const ruled = Boolean(process.env.TURN_RULED_PLAN) && event === "push" && process.env.GITHUB_REF === "refs/heads/main";
if (event && event !== "workflow_dispatch" && !ruled) fail(`a turn runs only on a dispatch (this run is a ${event}); the workflow gives the turn job its secrets on a dispatch only`);
// Past this line the sources are needed (a pull request run stops above and installs nothing).
const { STAGES, runTurn, opNames } = await import("../src/core/turn/index.ts");
const { buildDeps, enforceWired, startupCheck } = await import("../src/core/turn/wiring.ts");
const { serviceClient } = await import("../src/core/db/index.ts");

if (!values.stage || ![...STAGES, "all", "ops"].includes(values.stage)) fail(`--stage must be one of ${[...STAGES, "all", "ops"].join(", ")}`);
if (!["dry", "apply"].includes(values.mode)) fail("--mode must be dry or apply");
let input;
try {
  input = JSON.parse(inputText);
} catch (e) {
  fail(`--input is not JSON: ${e.message}`);
}
if (input === null || typeof input !== "object" || Array.isArray(input)) fail("--input must be a JSON object keyed by stage");
if (values.stage === "ops" && !Object.hasOwn(input.ops ?? {}, "op")) fail(`ops needs --input '{"ops":{"op":"<name>","args":{}}}' (ops: ${opNames().join(", ")})`);

const hasCreds = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = hasCreds ? buildDeps(serviceClient(), process.env) : null;
if (d) {
  // The same startup check the deployed app runs (IMP-026): an unwired required member stops the turn before it writes anything; a member owed to a slice that is not merged is said in the summary.
  const wiring = startupCheck(d);
  enforceWired(wiring);
  for (const o of wiring.owed) note("turn", `owed: ${o.member} (${o.owner})`);
}
const result = await runTurn({ stage: values.stage, mode: values.mode, trigger: event ? "dispatch" : "manual", chain: !values["no-chain"], input }, { d, env: process.env, now: () => new Date() });

const lines = result.runs.map((r) => (r.row ? `| ${r.row.family} | ${r.row.mode ?? "-"} | ${r.row.outcome} | ${String(r.row.reason ?? "").replace(/\|/g, "/").slice(0, 160)} |` : `| (not recorded) | - | - | ${String(r.error ?? "").slice(0, 160)} |`));
const table = [`### Turn ${result.rootRunId}`, "", `stage ${values.stage}, requested ${values.mode}, resolved ${result.resolved.mode}${result.resolved.forcedDry ? ` (${result.resolved.reason})` : ""}`, "", "| family | mode | outcome | reason |", "|---|---|---|---|", ...lines].join("\n");
for (const n of result.notes) note("turn", n);
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
if (result.exit === 2) note("turn", `${result.runs[0]?.error ?? "self-skipped: no credentials"}; exit 2`);
if (result.exit === 1) console.error(`turn: ${result.runs.find((r) => r.exit === 1)?.error ?? result.runs.find((r) => r.exit === 1)?.row?.error ?? "a record failed"}`);
if (process.env.TURN_RESULT_FILE) writeFileSync(process.env.TURN_RESULT_FILE, JSON.stringify({ root_run_id: result.rootRunId, resolved: result.resolved, exit: result.exit, runs: result.runs.map((r) => ({ family: r.row?.family ?? null, id: r.row?.id ?? null, mode: r.row?.mode ?? null, forced_dry: r.row?.forced_dry ?? false, outcome: r.row?.outcome ?? null, reason: r.row?.reason ?? null, counts: r.row?.outputs?.counts ?? {}, error: r.error ?? r.row?.error ?? null })) }));
process.exit(result.exit);
