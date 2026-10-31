// `npm run gates [-- --profile fast|full]`: the one list of checks a change must pass, in CI's order, fail-fast. Two profiles over ONE list (GATES-FAST-1):
// `full` (the default) is every step, and is what the `ci` job in ci.yml runs (`--profile full`; step names are log groups). `fast` is the steps marked `fast: true`, each measured under 60 s.
// GATES-FIX-1 (ruling 55): .githooks/pre-push runs `--memo --profile fast --range a..b` and never the full profile: the fast steps plus the test files of the modules the push changed (testFilesFor); the full matrix (build, the whole test suite, schema) is GitHub Actions', whose ci job is the merge gate.
// A pass on a clean tree is remembered in <git-dir>/gates-last-pass.json; under --memo (the hook) the same HEAD with the same clean tree and a covering profile is not run again. Never skipped in CI.
// Both profiles also run `schema:local` (schema-apply, then `joinability:schema`, the ci.yml schema job's two steps), on the embedded PostgreSQL, when a file under supabase/ differs from the upstream branch (@{upstream}, else origin/main); in CI the `schema` job owns that step.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMain } from "../lib/fs.mjs";

import { withLock } from "./lib/lock.mjs";
import { testArgs } from "./test.mjs";

const inCi = Boolean(process.env.GITHUB_ACTIONS);
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export const PROFILES = ["fast", "full"];

/** Every step is an npm script, so the failure line names a real script. `fast: true` puts a step in the fast profile (measured under 60 s on a workstation, and never `heavy`); a step without it is full-only. A `heavy` step (build, tests, schema:local) takes this clone's "gates" lock (scripts/ci/lib/lock.mjs, in its own git-dir): a clone never runs two of them at once (they share its .next and test-output.txt), and independent clones never wait for each other. */
export const STEPS = [
  { name: "Workflows are valid: YAML parses and the pinned actionlint finds nothing (IMP-100)", cmd: "workflow-yaml", fast: true },
  { name: "Lint", cmd: "lint", fast: true },
  { name: "Typecheck", cmd: "typecheck", fast: true },
  { name: "Build", cmd: "build", heavy: true, env: { NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder" } },
  { name: "Tests (output kept for the report job)", cmd: "test", heavy: true, capture: "test-output.txt" },
  { name: "Brief validator report (VALID-1, INV-VAL-5: every rule trips exactly the fixture rows labelled with it)", cmd: "validator-report", fast: true },
  { name: "Tree checks", cmd: "tree-checks", fast: true },
  { name: "UI checks", cmd: "ui-checks", fast: true },
  { name: "Client bundle walk (no \"use client\" file reaches a server-only module, node:crypto or a secret; audit 2026-10-23 2.4)", cmd: "client-walk", fast: true },
  { name: "LOC gates", cmd: "loc", fast: true },
  { name: "Connection check (nothing runs alone)", cmd: "connections", fast: true },
  { name: "Column check (every select, filter, write payload and rpc in src names a column or function the database defines)", cmd: "columns", fast: true },
  { name: "Joinability (a stored row is reachable by the engine: columns mapped, entities connected, units normalised)", cmd: "joinability", fast: true },
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

/** The paths changed in each `--range a..b` of argv, de-duplicated; a range git cannot read (a forced push, a remote commit not fetched) is measured from origin/main instead. */
export const rangeFiles = (argv) => [...new Set(argv.flatMap((a, i) => (argv[i - 1] === "--range" ? changedIn(a) : [])))];
const changedIn = (range) => {
  for (const r of [range, "origin/main...HEAD"]) {
    try {
      return git("diff", "--name-only", r).split("\n").filter(Boolean);
    } catch {
      /* try the next */
    }
  }
  return [];
};

const TEST_FILE = /^tests\/.*\.test\.(mjs|ts)$/;
/** The test files (of `tracked`, the repository's tracked tests) that cover `files`: src/core/<x>/** -> tests/<x>/** and tests/core/<x>/** (and tests/core/<x>.test.*); src/features/<x>/** -> tests/<x>/**; scripts/ci/** -> tests/ci/**; a changed test file runs itself. Sorted, de-duplicated. */
export function testFilesFor(files, tracked) {
  const want = new Set();
  const under = (dir) => tracked.filter((t) => t.startsWith(`${dir}/`)).forEach((t) => want.add(t));
  for (const f of files) {
    const core = /^src\/core\/([^/]+)\//.exec(f)?.[1];
    const feature = /^src\/features\/([^/]+)\//.exec(f)?.[1];
    if (core) {
      under(`tests/${core}`);
      under(`tests/core/${core}`);
      tracked.filter((t) => /^tests\/core\/[^/]+\.test\.(mjs|ts)$/.test(t) && t.slice(11).replace(/\.test\.(mjs|ts)$/, "") === core).forEach((t) => want.add(t));
    } else if (feature) under(`tests/${feature}`);
    else if (f.startsWith("scripts/ci/")) under("tests/ci");
    else if (TEST_FILE.test(f) && tracked.includes(f)) want.add(f);
  }
  return [...want].filter((t) => TEST_FILE.test(t)).sort();
}

/** Which profiles satisfy a required one: a full pass covers fast. */
const COVERS = { fast: ["fast", "full"], full: ["full"] };
/** GATES-FIX-1: the one-line reason a run is skipped, or null when it must run. `rec` is <git-dir>/gates-last-pass.json; the skip needs the same HEAD, a covering profile, a clean tree, no CI, and (when the hook asks for the changed modules' tests) a record that ran them. */
export function memoSkip(rec, { head, profile, clean, ci, targeted }) {
  if (ci || !clean || !rec || rec.sha !== head || !COVERS[profile].includes(rec.profile) || (targeted && !rec.targeted)) return null;
  return `gates: HEAD ${head.slice(0, 12)} already passed ${rec.profile} at ${rec.at}; skipping`;
}

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
  const r = step.files
    ? spawnSync(process.execPath, testArgs(undefined, step.files), { stdio: "inherit" })
    : spawnSync("npm", ["run", step.cmd], { shell: true, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ...step.env }, stdio: step.capture ? "pipe" : "inherit" });
  if (step.capture) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    writeFileSync(step.capture, out);
    process.stdout.write(out);
  }
  if (inCi) console.log("::endgroup::");
  return r.status ?? 1;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  let profile;
  try {
    profile = profileFrom(argv);
  } catch (e) {
    console.error(`gates: ${e.message}`);
    process.exit(2);
  }
  const gitDir = git("rev-parse", "--absolute-git-dir");
  const memoPath = join(gitDir, "gates-last-pass.json");
  const read = () => {
    try {
      return JSON.parse(readFileSync(memoPath, "utf8"));
    } catch {
      return null;
    }
  };
  const clean = () => git("status", "--porcelain") === "";
  const ranged = argv.includes("--range");
  const last = read();
  if (argv.includes("--memo")) {
    const line = memoSkip(last, { head: git("rev-parse", "HEAD"), profile, clean: clean(), ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS), targeted: ranged });
    if (line) {
      console.log(line);
      process.exit(0);
    }
  }
  const steps = stepsFor(profile).filter((s) => !s.scoped || inCi || s.scoped());
  if (!inCi && supabaseChanged()) steps.push({ name: "Schema on an embedded PostgreSQL 15 (supabase/ changed)", cmd: "schema:local", heavy: true });
  const tests = ranged ? testFilesFor(rangeFiles(argv), git("ls-files", "--", "tests").split("\n").filter(Boolean)) : [];
  if (tests.length) steps.push({ name: `Tests of the changed modules (${tests.length} file${tests.length === 1 ? "" : "s"})`, cmd: "test", files: tests, heavy: true });
  console.log(`gates (${profile}): ${steps.map((s) => s.cmd).join(", ")}${last?.profile === profile ? `; the last ${profile} pass took ${last.seconds}s` : ""}`);
  const lockDir = join(gitDir, "gates-lock");
  const started = Date.now();
  const skipped = [];
  for (const step of steps) {
    const t0 = Date.now();
    const code = step.heavy ? await withLock("gates", () => run(step), { dir: lockDir }) : run(step);
    console.log(`gates: ${step.cmd} ${Math.round((Date.now() - t0) / 1000)}s`);
    if (code === 2 && !inCi) {
      // a gate that cannot run here (no credentials) exits 2 after printing why: skipped, never a red and never counted as proven. CI never skips.
      console.log(`gates: ${step.cmd} SKIPPED (exit 2, see its reason above); it is proven in CI`);
      skipped.push(step.cmd);
      continue;
    }
    if (code !== 0) {
      console.error(`\ngates: FAILED at "${step.name}" (npm run ${step.cmd})`);
      process.exit(1);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (!inCi && clean()) writeFileSync(memoPath, JSON.stringify({ sha: git("rev-parse", "HEAD"), profile, at: new Date().toISOString(), seconds, targeted: ranged }) + "\n");
  console.log(`\ngates (${profile}): ${steps.length - skipped.length} passed${skipped.length ? `, ${skipped.length} skipped (${skipped.join(", ")})` : ""} in ${seconds}s`);
}
