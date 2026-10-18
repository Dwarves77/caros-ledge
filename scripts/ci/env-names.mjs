// The environment NAMES the tree reads (never a value): `process.env.X` / `env.X` in src, `Deno.env.get("X")` in the Edge Function, and the producer kill switches and free keys named in their specs. The cutover runbook
// (docs/runbooks/cutover-2026-10.md) lists exactly these, each with where it is set and where it is read; tests/cutover/env-names.test.ts fails when the two differ, so a new variable cannot be read without the runbook saying
// where to set it. `node scripts/ci/env-names.mjs` prints the list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const posix = (p) => p.replaceAll("\\", "/");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [posix(join(dir, e.name))] : []));

/** name -> the files that read it. */
export function envNamesRead(roots = ["src", "supabase/functions"]) {
  const names = new Map();
  const add = (name, file) => names.set(name, [...(names.get(name) ?? []), file]);
  for (const file of roots.flatMap(walk)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})\b/g)) add(m[1], file);
    for (const m of text.matchAll(/Deno\.env\.get\("([A-Z][A-Z0-9_]+)"\)/g)) add(m[1], file);
    for (const m of text.matchAll(/(?:killSwitchEnv|keyEnv|enabled_env)"?\s*:\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file);
  }
  for (const m of readFileSync("src/core/producers/data/registry.json", "utf8").matchAll(/"enabled_env":\s*"([A-Z0-9_]+)"/g)) add(m[1], "src/core/producers/data/registry.json");
  return new Map([...names].map(([k, v]) => [k, [...new Set(v)].sort()]).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) for (const [name, files] of envNamesRead()) console.log(`${name}\t${files.join(", ")}`);
