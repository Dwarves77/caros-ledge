// `npm run gates`: the one list of checks a change must pass, in CI's order, fail-fast. The `ci` job in ci.yml runs this script (step names are log groups),
// and .githooks/pre-push runs it before every push, so CI and the hook cannot drift. When a file under supabase/ differs from the upstream branch
// (@{upstream}, else origin/main), `schema:local` runs too, on the embedded PostgreSQL; in CI the `schema` job owns that step.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isMain } from "../lib/fs.mjs";

const inCi = Boolean(process.env.GITHUB_ACTIONS);
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Every step is an npm script, so the failure line names a real script. */
export const STEPS = [
  { name: "Workflows are valid: YAML parses and the pinned actionlint finds nothing (IMP-100)", cmd: "workflow-yaml" },
  { name: "Lint", cmd: "lint" },
  { name: "Typecheck", cmd: "typecheck" },
  { name: "Build", cmd: "build", env: { NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder" } },
  { name: "Tests (output kept for the report job)", cmd: "test", capture: "test-output.txt" },
  { name: "Tree checks", cmd: "tree-checks" },
  { name: "UI checks", cmd: "ui-checks" },
  { name: "Client bundle walk (no \"use client\" file reaches a server-only module, node:crypto or a secret; audit 2026-10-23 2.4)", cmd: "client-walk" },
  { name: "LOC gates", cmd: "loc" },
  { name: "Connection check (nothing runs alone)", cmd: "connections" },
  { name: "Column check (every select, filter, write payload and rpc in src names a column or function the database defines)", cmd: "columns" },
  { name: "Propagation method versions (INV-202: a released method is never edited; new behaviour is a new version)", cmd: "method-versions" },
  { name: "Migration static checks (self-check, reversal, README, APPLY.md, borrowed rows)", cmd: "migration-checks" },
  { name: "Edge Function bundle (IMP-029: capture-worker bundles with its relative policy import)", cmd: "edge-bundle", scoped: () => edgeChanged() },
];

/** True when a file under any of `paths` differs from the upstream branch (origin/main when there is none), committed or not. */
function changedUnder(...paths) {
  let base;
  try {
    base = git("rev-parse", "--abbrev-ref", "@{upstream}");
  } catch {
    base = "origin/main"; // no upstream configured
  }
  try {
    return git("diff", "--name-only", base, "--", ...paths).length > 0 || git("ls-files", "--others", "--exclude-standard", ...paths).length > 0;
  } catch {
    return true; // cannot tell: run the check
  }
}
export const supabaseChanged = () => changedUnder("supabase/");
/** The Edge Function bundle is worth a download of Deno only when the worker or the policy it imports changed (in CI it always runs). */
export const edgeChanged = () => changedUnder("supabase/functions/", "src/core/fetch/policy.ts", "scripts/ci/edge-bundle.mjs", "scripts/ci/deno-bundle.json");

function run(step) {
  if (inCi) console.log(`::group::${step.name}`);
  else console.log(`\n== ${step.name}`);
  const r = spawnSync("npm", ["run", step.cmd], { shell: true, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ...step.env }, stdio: step.capture ? "pipe" : "inherit" });
  if (step.capture) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    writeFileSync(step.capture, out);
    process.stdout.write(out);
  }
  if (inCi) console.log("::endgroup::");
  return r.status ?? 1;
}

if (isMain(import.meta.url)) {
  const stamp = execFileSync("git", ["rev-parse", "--git-path", "gates-last"], { encoding: "utf8" }).trim();
  const last = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
  const steps = STEPS.filter((s) => !s.scoped || inCi || s.scoped());
  if (!inCi && supabaseChanged()) steps.push({ name: "Schema on an embedded PostgreSQL 15 (supabase/ changed)", cmd: "schema:local" });
  console.log(`gates: ${steps.map((s) => s.cmd).join(", ")}${last ? `; the last run took ${last}s` : ""}`);
  const started = Date.now();
  for (const step of steps) {
    const code = run(step);
    if (code !== 0) {
      console.error(`\ngates: FAILED at "${step.name}" (npm run ${step.cmd})`);
      process.exit(1);
    }
  }
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, `${Math.round((Date.now() - started) / 1000)}\n`);
  console.log(`\ngates: all ${steps.length} passed in ${Math.round((Date.now() - started) / 1000)}s`);
}
