// The scope of a change, decided once for the whole workflow (the `changes` job): which of the expensive jobs a pull request needs. A push to main and a dispatch run everything, so nothing is ever skipped
// on the branch the deployments come from. A pull request runs a job when the diff against its base touches a path the job reads:
//   parity   everything the build reads (a change under src/, public/, a manifest, the build config, tests/_support, supabase/, the workflow) can change what a page renders;
//   windows  scripts/ and tests/ (the platform of the author's pre-push hook: a Windows-only break in a path or a line ending is found on the PR, not one merge later);
//   edge     a push to main that touches the Edge Function or the fetch core it bundles (the diff of the push, BEFORE..HEAD): the only event that deploys capture-worker;
//   plans    a push to main that changed a ruled-run plan (scripts/runs/plans/*.json) whose `applied` is not true: the paths, space separated, for the `ruled-runs` job (INV-RUN-3: the results commit flips `applied`, so a plan runs once);
//   node scripts/ci/changes.mjs   reads EVENT, BASE (the pull request's base branch) and BEFORE (the push's previous head) from the environment and writes parity, windows, edge and plans to $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

import { isMain } from "../lib/fs.mjs";

export const PARITY = /^(src\/|public\/|package(-lock)?\.json$|next\.config\.ts$|tsconfig\.json$|tests\/(parity|ux|_support)\/|supabase\/|\.github\/workflows\/ci\.yml$)/;
export const WINDOWS = /^(scripts\/|tests\/)/;
export const EDGE = /^(supabase\/functions\/|src\/core\/fetch\/)/;

/** The jobs a change needs. `files` are the changed paths; any event but a pull request needs everything, and only a push can deploy the Edge Function. */
export function scopeOf(files, event) {
  const any = (re) => files.some((f) => re.test(f));
  const edge = event === "push" && any(EDGE);
  return event === "pull_request" ? { parity: any(PARITY), windows: any(WINDOWS), edge } : { parity: true, windows: true, edge };
}

const PLAN = /^scripts\/runs\/plans\/[\w.-]+\.json$/;
/** The changed plans that still exist (a deleted plan runs nothing); `exists(path)` says whether the file is there. */
export const pendingPlans = (files, exists) => files.filter((f) => PLAN.test(f) && exists(f));

if (isMain(import.meta.url)) {
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
