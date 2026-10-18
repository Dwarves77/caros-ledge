// The environment NAMES the tree reads (never a value): `process.env.X`, `process.env["X"]`, `env.X`, `env["X"]` and an env read through a string constant (`env[EIA_KEY_ENV]`, the constant resolved across the tree) in src, `Deno.env.get("X")` in the Edge Function, and the producer kill switches and free keys named in their specs. The cutover runbook
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
  const texts = new Map(roots.flatMap(walk).map((f) => [f, readFileSync(f, "utf8")]));
  // UPPER_SNAKE string constants (exported or not), by identifier: the indirection an env read goes through.
  const consts = new Map();
  for (const text of texts.values()) for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) consts.set(m[1], m[2]);
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})\b/g)) add(m[1], file);
    for (const m of text.matchAll(/\benv\s*\??\.?\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\]/g)) add(m[1], file);
    for (const m of text.matchAll(/\benv\s*\??\.?\[\s*([A-Z][A-Z0-9_]*)\s*\]/g)) if (consts.has(m[1])) add(consts.get(m[1]), file);
    for (const m of text.matchAll(/\b(?:killSwitchEnv|keyEnv|enabled_env)\s*:\s*([A-Z][A-Z0-9_]*)\s*[,}\n]/g)) if (consts.has(m[1])) add(consts.get(m[1]), file);
    for (const m of text.matchAll(/Deno\.env\.get\("([A-Z][A-Z0-9_]+)"\)/g)) add(m[1], file);
    for (const m of text.matchAll(/(?:killSwitchEnv|keyEnv|enabled_env)"?\s*:\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file);
  }
  for (const m of readFileSync("src/core/producers/data/registry.json", "utf8").matchAll(/"enabled_env":\s*"([A-Z0-9_]+)"/g)) add(m[1], "src/core/producers/data/registry.json");
  return new Map([...names].map(([k, v]) => [k, [...new Set(v)].sort()]).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) for (const [name, files] of envNamesRead()) console.log(`${name}\t${files.join(", ")}`);
