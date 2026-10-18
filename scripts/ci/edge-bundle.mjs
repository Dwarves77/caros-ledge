// IMP-029: the capture-worker Edge Function bundles. supabase/functions/capture-worker/index.ts imports the fetch policy of src/core/fetch/policy.ts by a relative path (../../../src/core/fetch/policy.ts), so the Node
// transports and the worker share one policy; this proves the bundler accepts that import and that the policy lands in the bundle. The Supabase CLI has no build command (2.95.4 and 2.121.0 were read: functions list, delete,
// download, deploy, new, serve), and `deploy` needs a linked project, so the proof is Deno's own bundler (the Edge runtime is Deno) on the same entry point, with a config that names no project and no node_modules
// (scripts/ci/deno-bundle.json). Deno comes from npm at a pinned version. The policy module moves only if this fails (the brief's fallback); it has not been needed.
//   node scripts/ci/edge-bundle.mjs            exit 0 bundled, 1 refused or the policy is missing from the bundle
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DENO = "deno@2.5.6";
export const ENTRY = "supabase/functions/capture-worker/index.ts";
/** What a bundle of the worker must contain: the policy's fetch (from the relative import), the worker's drain and its PDF text extraction. */
export const SENTINELS = ["fetchDocument", "storageMaxChars", "isServiceRoleRequest", "extractText"];

/** The problems of a bundle's text: one per sentinel it lacks. Pure. */
export function bundleProblems(text) {
  return SENTINELS.filter((s) => !text.includes(s)).map((s) => `the bundle does not contain ${s}: the relative import of the fetch policy (or a worker module) did not land in it`);
}

export function bundleWorker(entry = ENTRY) {
  const dir = mkdtempSync(join(tmpdir(), "edge-bundle-"));
  const out = join(dir, "capture-worker.js");
  try {
    const r = spawnSync("npx", ["--yes", DENO, "bundle", "--no-lock", "--config", "scripts/ci/deno-bundle.json", "--platform", "deno", entry, "-o", out], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 1 << 26 });
    if (r.status !== 0) return { ok: false, problems: [`deno bundle refused ${entry} (exit ${r.status}): ${String(r.stderr).split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" | ") || String(r.stderr).slice(-300)}`] };
    const problems = bundleProblems(readFileSync(out, "utf8"));
    return { ok: problems.length === 0, problems, bytes: statSync(out).size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = bundleWorker();
  for (const p of r.problems) console.error(p);
  console.log(r.ok ? `edge-bundle: capture-worker bundles with the relative policy import (${r.bytes} bytes, ${DENO})` : "edge-bundle: FAILED");
  process.exit(r.ok ? 0 : 1);
}
