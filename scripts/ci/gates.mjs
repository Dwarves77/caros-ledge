// `npm run gates [-- --profile fast|full]`: the one list of checks a change must pass, in CI's order, fail-fast. Two profiles over ONE list (GATES-FAST-1):
// `full` (the default) is every step, and is what the `ci` job in ci.yml runs (`--profile full`; step names are log groups). `fast` is the steps marked `fast: true`, each measured
// under 60 s, and is what .githooks/pre-push runs, so a push is gated in minutes while the full suite (build, the whole test suite, the client bundle walk, schema:local) runs in CI.
// The full profile also runs `schema:local`, on the embedded PostgreSQL, when a file under supabase/ differs from the upstream branch (@{upstream}, else origin/main); in CI the `schema` job owns that step.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isMain } from "../lib/fs.mjs";

import { withLock } from "./lib/lock.mjs";

const inCi = Boolean(process.env.GITHUB_ACTIONS);
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export const PROFILES = ["fast", "full"];

/** Every step is an npm script, so the failure line names a real script. `fast: true` puts a step in the fast profile (measured under 60 s on a workstation, and never `heavy`); a step without it is full-only. A `heavy` step (build, tests, schema:local) takes the cross-process "gates" lock (scripts/ci/lib/lock.mjs): two lanes on one workstation never run them at once; the cheap checks stay outside it and report fast, so the lock applies to the full profile only. */
export const STEPS = [
  { name: "Workflows are valid: YAML parses and the pinned actionlint finds nothing (IMP-100)", cmd: "workflow-yaml", fast: true },
  { name: "Lint", cmd: "lint", fast: true },
  { name: "Typecheck", cmd: "typecheck", fast: true },
  { name: "Build", cmd: "build", heavy: true, env: { NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder" } },
  { name: "Tests (output kept for the report job)", cmd: "test", heavy: true, capture: "test-output.txt" },
  { name: "Brief validator report (VALID-1, INV-VAL-5: every rule trips exactly the fixture rows labelled with it)", cmd: "validator-report", fast: true },
  { name: "Tree checks", cmd: "tree-checks", fast: true },
  { name: "UI checks", cmd: "ui-checks", fast: true },
  { name: "Client bundle walk (no \"use client\" file reaches a server-only module, node:crypto or a secret; audit 2026-10-23 2.4)", cmd: "client-walk" },
  { name: "LOC gates", cmd: "loc", fast: true },
  { name: "Connection check (nothing runs alone)", cmd: "connections", fast: true },
  { name: "Column check (every select, filter, write payload and rpc in src names a column or function the database defines)", cmd: "columns", fast: true },
  { name: "Citation check (a path, line range or table.column a document cites exists: CITE-1)", cmd: "verify:citations", fast: true },
  { name: "Propagation method versions (INV-202: a released method is never edited; new behaviour is a new version)", cmd: "method-versions", fast: true },
  { name: "Migration static checks (self-check, reversal, number ledger and order, README, borrowed rows)", cmd: "migration-checks", fast: true },
  { name: "Edge Function bundle (IMP-029: capture-worker bundles with its relative policy import)", cmd: "edge-bundle", scoped: () => edgeChanged() },
];

/** The step list of a profile, in order: `full` is every step, `fast` only those marked `fast: true`. */
export const stepsFor = (profile) => {
  if (!PROFILES.includes(profile)) throw new Error(`unknown gates profile "${profile}" (expected ${PROFILES.join(" or ")})`);
  return profile === "full" ? [...STEPS] : STEPS.filter((s) => s.fast);
};

/** `--profile fast|full` or `--profile=fast|full` from argv; full when absent. */
export function profileFrom(argv) {
  const i = argv.findIndex((a) => a === "--profile" || a.startsWith("--profile="));
  if (i < 0) return "full";
  const value = argv[i].includes("=") ? argv[i].slice("--profile=".length) : argv[i + 1];
  if (!PROFILES.includes(value)) throw new Error(`unknown gates profile "${value ?? ""}" (expected ${PROFILES.join(" or ")})`);
  return value;
}

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
  let profile;
  try {
    profile = profileFrom(process.argv.slice(2));
  } catch (e) {
    console.error(`gates: ${e.message}`);
    process.exit(2);
  }
  const stampName = profile === "full" ? "gates-last" : "gates-last-fast";
  const stamp = execFileSync("git", ["rev-parse", "--git-path", stampName], { encoding: "utf8" }).trim();
  const last = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
  const steps = stepsFor(profile).filter((s) => !s.scoped || inCi || s.scoped());
  if (profile === "full" && !inCi && supabaseChanged()) steps.push({ name: "Schema on an embedded PostgreSQL 15 (supabase/ changed)", cmd: "schema:local", heavy: true });
  console.log(`gates (${profile}): ${steps.map((s) => s.cmd).join(", ")}${last ? `; the last ${profile} run took ${last}s` : ""}`);
  const started = Date.now();
  for (const step of steps) {
    const t0 = Date.now();
    const code = step.heavy ? await withLock("gates", () => run(step)) : run(step);
    console.log(`gates: ${step.cmd} ${Math.round((Date.now() - t0) / 1000)}s`);
    if (code !== 0) {
      console.error(`\ngates: FAILED at "${step.name}" (npm run ${step.cmd})`);
      process.exit(1);
    }
  }
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, `${Math.round((Date.now() - started) / 1000)}\n`);
  console.log(`\ngates (${profile}): all ${steps.length} passed in ${Math.round((Date.now() - started) / 1000)}s`);
}
