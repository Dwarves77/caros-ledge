// IMP-029: the capture-worker Edge Function bundles. supabase/functions/capture-worker/index.ts imports the fetch policy of src/core/fetch/policy.ts by a relative path (../../../src/core/fetch/policy.ts), so the Node
// transports and the worker share one policy; this proves the bundler accepts that import and that the policy lands in the bundle. The Supabase CLI has no build command (2.95.4 and 2.121.0 were read: functions list, delete,
// download, deploy, new, serve), and `deploy` needs a linked project, so the proof is Deno's own bundler (the Edge runtime is Deno) on the same entry point, with a config that names no project and no node_modules
// (scripts/ci/deno-bundle.json). Deno comes from npm at a pinned version (a devDependency would put its 100 MB binary in every job's install; the one job that bundles downloads it). The policy module moves only if this fails (the brief's fallback); it has not been needed.
// What is asserted is structure, never a substring: the bundle of process.ts must EXPORT exactly the values its source exports (the export map), and the bundle of index.ts must DECLARE (as a top-level function) every
// name the worker takes from the policy and from the PDF reader. A comment or string that mentions a name satisfies neither.
//   node scripts/ci/edge-bundle.mjs            exit 0 bundled, 1 refused or the structure is wrong
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isMain } from "../lib/fs.mjs";

export const DENO = "deno@2.5.6";
export const ENTRY = "supabase/functions/capture-worker/index.ts";
export const PROCESS = "supabase/functions/capture-worker/process.ts";
/** The names the entry's bundle must declare: the policy's fetch (from the relative import), the storage cap, the worker's request check, and the PDF text extraction (the bundler suffixes a clashing name with `$<n>`). */
export const DECLARED = ["fetchDocument", "storageMaxChars", "isServiceRoleRequest", "extractText"];

/** The values a TypeScript module exports (functions and consts; types do not exist in the bundle), sorted. */
export function sourceExports(text) {
  return [...text.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]).sort();
}

/** The names a bundle's `export { ... }` clauses export (`a as b` exports b), sorted. */
export function bundleExports(text) {
  return [...text.matchAll(/^export \{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)).sort();
}

/** The top-level declared function, class and const names of a bundle, without the bundler's `$<n>` suffix. */
export function declaredNames(text) {
  return new Set([...text.matchAll(/^(?:async )?(?:function\*?|class) ([\w$]+)|^(?:const|let|var) ([\w$]+)\s*=/gm)].map((m) => (m[1] ?? m[2]).replace(/\$\d*$/, "")));
}

/** The problems of the two bundles' texts. Pure. */
export function bundleProblems({ entry, process: proc, processSource }) {
  const problems = [];
  const want = sourceExports(processSource);
  const have = bundleExports(proc);
  if (JSON.stringify(want) !== JSON.stringify(have)) problems.push(`the process.ts bundle exports [${have}] where its source exports [${want}]: the export map changed in the bundle`);
  const declared = declaredNames(entry);
  for (const name of DECLARED) if (!declared.has(name)) problems.push(`the entry bundle does not declare ${name}: the relative import of the fetch policy (or a worker module) did not land in it`);
  if (!/^Deno\.serve\(/m.test(entry)) problems.push("the entry bundle never calls Deno.serve: the worker would not answer a request");
  return problems;
}

function bundle(entry, out) {
  const r = spawnSync("npx", ["--yes", DENO, "bundle", "--no-lock", "--config", "scripts/ci/deno-bundle.json", "--platform", "deno", entry, "-o", out], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 1 << 26 });
  if (r.status !== 0) return `deno bundle refused ${entry} (exit ${r.status}): ${String(r.stderr).split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" | ") || String(r.stderr).slice(-300)}`;
  return null;
}

export function bundleWorker() {
  const dir = mkdtempSync(join(tmpdir(), "edge-bundle-"));
  try {
    const [entryOut, procOut] = [join(dir, "capture-worker.js"), join(dir, "process.js")];
    const refused = bundle(ENTRY, entryOut) ?? bundle(PROCESS, procOut);
    if (refused) return { ok: false, problems: [refused] };
    const problems = bundleProblems({ entry: readFileSync(entryOut, "utf8"), process: readFileSync(procOut, "utf8"), processSource: readFileSync(PROCESS, "utf8") });
    return { ok: problems.length === 0, problems, bytes: statSync(entryOut).size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const r = bundleWorker();
  for (const p of r.problems) console.error(p);
  console.log(r.ok ? `edge-bundle: capture-worker bundles with the relative policy import (${r.bytes} bytes, ${DENO})` : "edge-bundle: FAILED");
  process.exit(r.ok ? 0 : 1);
}
