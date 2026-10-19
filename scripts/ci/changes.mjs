// The scope of a change, decided once for the whole workflow (the `changes` job): which of the expensive jobs a pull request needs. A push to main and a dispatch run everything, so nothing is ever skipped
// on the branch the deployments come from. A pull request runs a job when the diff against its base touches a path the job reads:
//   parity   everything the build reads (a change under src/, public/, a manifest, the build config, tests/_support, supabase/, the workflow) can change what a page renders;
//   windows  scripts/ and tests/ (the platform of the author's pre-push hook: a Windows-only break in a path or a line ending is found on the PR, not one merge later);
//   mutants  fast always; slow (a build, a bundle) when the sources they read changed; schema when the database, its checks or the runner changed.
//   node scripts/ci/changes.mjs   reads EVENT and BASE (the pull request's base branch) from the environment and writes parity, windows and mutant_classes to $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { isMain } from "../lib/fs.mjs";

export const PARITY = /^(src\/|public\/|package(-lock)?\.json$|next\.config\.ts$|tsconfig\.json$|tests\/(parity|ux|_support)\/|supabase\/|\.github\/workflows\/ci\.yml$)/;
export const WINDOWS = /^(scripts\/|tests\/)/;
export const MUTANTS_ALL = /^(tests\/mutants\/|scripts\/ci\/mutants)/;
export const MUTANTS_SLOW = /^(src\/|package(-lock)?\.json$|next\.config\.ts$|tsconfig\.json$|supabase\/functions\/|scripts\/ci\/edge-bundle|\.github\/workflows\/)/;
export const MUTANTS_SCHEMA = /^(supabase\/|scripts\/ci\/|scripts\/gen\/|scripts\/lib\/|tests\/_support\/schema\.json$|src\/core\/contracts\/)/;

/** The jobs a change needs. `files` are the changed paths; any event but a pull request needs everything. */
export function scopeOf(files, event) {
  if (event !== "pull_request") return { parity: true, windows: true, mutant_classes: "fast,slow,schema" };
  const any = (re) => files.some((f) => re.test(f));
  const all = any(MUTANTS_ALL);
  const classes = ["fast", ...(all || any(MUTANTS_SLOW) ? ["slow"] : []), ...(all || any(MUTANTS_SCHEMA) ? ["schema"] : [])];
  return { parity: any(PARITY), windows: any(WINDOWS), mutant_classes: classes.join(",") };
}

if (isMain(import.meta.url)) {
  const { EVENT = "", BASE = "" } = process.env;
  const files = EVENT === "pull_request" ? execFileSync("git", ["diff", "--name-only", `origin/${BASE}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean) : [];
  const scope = scopeOf(files, EVENT);
  console.log(`changes: ${EVENT || "(no event)"}, ${files.length} file(s): ${JSON.stringify(scope)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([k, v]) => `${k}=${v}\n`).join(""));
}
