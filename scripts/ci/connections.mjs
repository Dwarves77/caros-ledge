// The connection check (rule 17: nothing runs alone). It walks src/ and fails when
//   1. an exported runtime entry (a function returning a RunResult) has no caller in src/core/turn, a route, or another runtime that is itself called;
//   2. a stage in STAGES has a family with no downstream and no stated reason it ends (src/core/harness/data/families.json);
//   3. a surface reader (a file under src/features/<module>/read|server|queries) reads a table that nothing outside the readers writes: a page-local engine, or data nobody produces.
// It prints the connection map into the job summary: the living version of ASSEMBLY D.1.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src";
const posix = (p) => p.split("\\").join("/");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [posix(join(dir, e.name))] : []));
const files = walk(ROOT);
// An import line is not a call: a runtime that is only imported (never named again) has no caller.
const IMPORT_LINE = /^[ \t]*import\b[^;'"]*?["'][^"']+["'];?[ \t]*$/gm;
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(IMPORT_LINE, "").split("\n").filter((l) => !l.trim().startsWith("//") && !/^\s*export\s*(\*|\{|type\s*\{)[^;]*from\s/.test(l)).join("\n");
const src = new Map(files.map((f) => [f, strip(readFileSync(f, "utf8"))]));

const isRoot = (f) => f.startsWith("src/core/turn/") || f.startsWith("src/app/") || /^src\/features\/[^/]+\/api\//.test(f) || f === "src/instrumentation.ts";
const isReader = (f) => /^src\/features\/[^/]+\/(read|server|queries)\//.test(f);

// The names that mean "a runtime result": RunResult and every type that extends or intersects it.
const resultTypes = new Set(["RunResult"]);
for (let grew = true; grew; ) {
  grew = false;
  for (const text of src.values()) {
    for (const m of text.matchAll(/export (?:type|interface) (\w+)(?:<[^>]*>)?\s*(?:=|extends)\s*([^;{]*)/g)) {
      if (!resultTypes.has(m[1]) && [...resultTypes].some((t) => new RegExp(`\\b${t}\\b`).test(m[2]))) {
        resultTypes.add(m[1]);
        grew = true;
      }
    }
  }
}
const returnsResult = (ret) => [...resultTypes].some((t) => new RegExp(`\\b${t}\\b`).test(ret));

/** Exported functions whose return type is a runtime result. */
function entriesOf(file, text) {
  const out = [];
  for (const m of text.matchAll(/export (?:async )?function (\w+)\s*(?:<[^(]*>)?\(|export const (\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g)) {
    const name = m[1] ?? m[2];
    let i = m.index + m[0].length;
    for (let depth = 1; i < text.length && depth > 0; i += 1) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
    const rest = text.slice(i, i + 400);
    const ret = /^\s*:\s*([\s\S]*?)(?:\{|=>)/.exec(rest)?.[1] ?? "";
    if (ret && returnsResult(ret)) out.push({ name, file });
  }
  return out;
}
const entries = [...src].flatMap(([f, t]) => entriesOf(f, t));
const mentions = (text, name) => (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;

// The import graph (re-exports included), so a file is reachable when a root imports it, directly or through a barrel.
const raw = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const resolve = (from, spec) => {
  const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? posix(join(from, "..", spec)) : null;
  return base ? [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((c) => raw.has(c)) ?? null : null;
};
const importsOf = (f) => [...raw.get(f).matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => resolve(f, m[1])).filter(Boolean);
const reachable = new Set();
for (const queue = files.filter(isRoot); queue.length; ) {
  const f = queue.pop();
  if (reachable.has(f)) continue;
  reachable.add(f);
  queue.push(...importsOf(f));
}
// Called: named in a reachable file other than its own (a barrel's re-export line does not count), or used again inside its own reachable file.
const called = new Map();
for (const e of entries) {
  const by = [...src].filter(([f, t]) => f !== e.file && reachable.has(f) && mentions(t, e.name) > 0).map(([f]) => f);
  if (by.length || (reachable.has(e.file) && mentions(src.get(e.file), e.name) > 1)) called.set(e.name + e.file, by.length ? by : [e.file]);
}
const allow = JSON.parse(readFileSync("scripts/ci/connections-allow.json", "utf8"));
const problems = entries.filter((e) => !called.has(e.name + e.file) && !allow.entries[`${e.file}#${e.name}`]).map((e) => `${e.file}: ${e.name} is a runtime entry with no caller in src/core/turn, a route or another runtime`);

// 2. every stage records a downstream (or says why it ends).
const stages = [...readFileSync("src/core/turn/registry.ts", "utf8").match(/export const STAGES = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const families = JSON.parse(readFileSync("src/core/harness/data/families.json", "utf8"));
for (const s of stages) {
  const fam = families.find((f) => f.stage === s);
  if (!fam) problems.push(`stage ${s} has no family in families.json`);
  else if (!fam.downstream.length && !fam.terminal) problems.push(`stage ${s} (family ${fam.name}) records no downstream and no reason it ends`);
}
for (const [a, b] of stages.slice(0, -1).map((s, i) => [s, stages[i + 1]])) {
  const fa = families.find((f) => f.stage === a);
  const fb = families.find((f) => f.stage === b);
  if (fa && fb && !fa.downstream.includes(fb.name)) problems.push(`stage ${a} does not hand off to the next stage ${b}: ${fa.name} lists [${fa.downstream}]`);
}

// 3. a surface reader reads only what something writes.
const WRITE = /\.from\(\s*"(\w+)"\s*\)(?:(?!\.from\()[\s\S]){0,400}?\.(?:insert|update|upsert|delete)\(/g;
const written = new Set([...allow.written]);
for (const [f, t] of src) if (!isReader(f)) for (const m of t.matchAll(WRITE)) written.add(m[1]);
const readsOf = new Map();
for (const [f, t] of src) if (isReader(f)) for (const m of t.matchAll(/\.from\(\s*"(\w+)"\s*\)/g)) readsOf.set(m[1], [...(readsOf.get(m[1]) ?? []), f]);
for (const [table, by] of readsOf) if (!written.has(table)) problems.push(`${[...new Set(by)].join(", ")}: reads ${table}, which no machine stage, route or runtime writes (a page-local engine, or data nobody produces)`);

// The map.
const map = [
  "### Connection map",
  "",
  "| stage | family | downstream | calls |",
  "|---|---|---|---|",
  ...stages.map((s) => {
    const fam = families.find((f) => f.stage === s);
    const text = [...src].filter(([f]) => f.startsWith(`src/core/turn/stages/${s}.`)).map(([, t]) => t).join("\n");
    const calls = [...new Set([...text.matchAll(/from "@\/(?:features|core)\/([\w/-]+)"/g)].map((m) => m[1]))].filter((c) => !c.startsWith("harness") && !c.startsWith("types") && !c.startsWith("turn"));
    return `| ${s} | ${fam?.name ?? "?"} | ${fam?.downstream.join(", ") || `ends: ${fam?.terminal ?? "?"}`} | ${calls.join(", ")} |`;
  }),
  "",
  `${entries.length} runtime entries, ${[...called.keys()].length} called, ${entries.length - called.size - problems.filter((p) => p.includes("runtime entry")).length} allowed; ${readsOf.size} tables read by surface readers; ${problems.length} problem(s).`,
];
const table = map.join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
for (const p of problems) console.error(p);
process.exit(problems.length ? 1 : 0);
void relative;
