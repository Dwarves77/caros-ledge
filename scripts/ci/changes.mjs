// The scope of a change, decided once for the whole workflow (the `changes` job). CI-TRIM-1: a pull request is the gate (ci, schema and parity run there; main is not re-tested, so a pull request must be up to date with main to merge),
// and a push to main runs only changes, migrate, edge-deploy and ruled-runs. ci-windows is a dispatch (only=windows), never a pull request or a push. A pull request runs parity when the diff against its base touches a path the build reads:
//   parity   everything the build reads (a change under src/, public/, a manifest, the build config, tests/_support, supabase/, the workflow) can change what a page renders;
//   edge     a push to main that touches the Edge Function or the fetch core it bundles (the diff of the push, BEFORE..HEAD): the only event that deploys capture-worker;
//   plans    a push to main that changed a ruled-run plan (scripts/runs/plans/*.json) whose `applied` is not true: the paths, space separated, for the `ruled-runs` job (INV-RUN-3: the results commit flips `applied`, so a plan runs once);
//   browser  inside `ruled-runs`: do the pending plans run a step that drives a browser (a capture or sweep stage, or a chained step), so the Playwright Chromium install is needed before the plans run;
//   visible  inside `ruled-runs`: the newest results file names applied items, so scripts/runs/visible.mjs runs (and needs a Chromium if the plans did not already install one);
//   node scripts/ci/changes.mjs            reads EVENT, BASE (the pull request's base branch) and BEFORE (the push's previous head) from the environment and writes parity, edge and plans to $GITHUB_OUTPUT.
//   node scripts/ci/changes.mjs --browser  reads PLANS (the pending plan paths) and writes browser=true|false.   node scripts/ci/changes.mjs --visible  reads the newest scripts/runs/results/*.json and writes visible=true|false and file=<path>.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { isMain } from "../lib/fs.mjs";

export const PARITY = /^(src\/|public\/|package(-lock)?\.json$|next\.config\.ts$|tsconfig\.json$|tests\/(parity|ux|_support)\/|supabase\/|\.github\/workflows\/ci\.yml$)/;
export const EDGE = /^(supabase\/functions\/|src\/core\/fetch\/)/;

/** The jobs a change needs. `files` are the changed paths; any event but a pull request needs parity (a dispatch), and only a push can deploy the Edge Function. */
export function scopeOf(files, event) {
  const any = (re) => files.some((f) => re.test(f));
  const edge = event === "push" && any(EDGE);
  return event === "pull_request" ? { parity: any(PARITY), edge } : { parity: true, edge };
}

const PLAN = /^scripts\/runs\/plans\/[\w.-]+\.json$/;
/** The changed plans that still exist (a deleted plan runs nothing); `exists(path)` says whether the file is there. */
export const pendingPlans = (files, exists) => files.filter((f) => PLAN.test(f) && exists(f));

/** The stages whose firing drives a browser: capture (the headless tier of the fetch ladder) and the sweeps. A step that chains runs the stages downstream of its own, so it can reach capture too. */
export const BROWSER_STAGES = new Set(["capture", "sweep", "sweep-research"]);
/** Whether any of the plan files (`read(path)` returns the JSON text) has a step that drives a browser. A plan that cannot be read or parsed needs one (the install is cheap next to a run that dies for want of it). */
export function needsBrowser(plans, read) {
  return plans.some((p) => {
    try {
      return (JSON.parse(read(p)).steps ?? []).some((s) => BROWSER_STAGES.has(s.stage) || s.chain === true);
    } catch {
      return true;
    }
  });
}

/** The newest results file of `dir` with its applied item ids: `{file, ids}`, or null when the directory holds none. The seams are injected so a test touches no disk. */
export function latestResults(dir, { list = readdirSync, mtime = (p) => statSync(p).mtimeMs, read = (p) => readFileSync(p, "utf8") } = {}) {
  let names;
  try {
    names = list(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  const files = names.map((n) => `${dir}/${n}`).sort((a, b) => mtime(b) - mtime(a));
  if (!files.length) return null;
  try {
    const ids = JSON.parse(read(files[0])).applied_item_ids;
    return { file: files[0], ids: Array.isArray(ids) ? ids : [] };
  } catch {
    return { file: files[0], ids: [] };
  }
}

const out = (pairs) => {
  console.log(`changes: ${JSON.stringify(pairs)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
};

if (isMain(import.meta.url) && process.argv.includes("--browser")) {
  out({ browser: needsBrowser((process.env.PLANS ?? "").split(/\s+/).filter(Boolean), (p) => readFileSync(p, "utf8")) });
} else if (isMain(import.meta.url) && process.argv.includes("--visible")) {
  const r = latestResults("scripts/runs/results");
  out({ visible: Boolean(r?.ids.length), file: r?.file ?? "" });
} else if (isMain(import.meta.url)) {
  const { EVENT = "", BASE = "", BEFORE = "" } = process.env;
  const range = EVENT === "pull_request" ? `origin/${BASE}...HEAD` : EVENT === "push" ? `${BEFORE}..HEAD` : "";
  const files = range ? execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" }).split("\n").filter(Boolean) : [];
  const scope = scopeOf(files, EVENT);
  console.log(`changes: ${EVENT || "(no event)"}, ${files.length} file(s): ${JSON.stringify(scope)}`);
  const plans = EVENT === "push" ? pendingPlans(files, existsSync) : [];
  console.log(`changes: pending plans: ${plans.join(" ") || "none"}`);
  if (EVENT === "push" && !scope.edge && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "edge-deploy skipped: this push changes nothing under supabase/functions or src/core/fetch.\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({ ...scope, plans: plans.join(" ") }).map(([k, v]) => `${k}=${v}\n`).join(""));
}
