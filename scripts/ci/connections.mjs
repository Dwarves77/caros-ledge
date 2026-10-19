// The connection check (rule 17: nothing runs alone). It reads the tree as a graph (scripts/ci/connections/graph.mjs, from the TypeScript syntax tree) and fails when
//   1. a value export has no caller: nothing reachable from a route, a page, the instrumentation hook, a script or the Edge Function names it in code (a comment, a string or a type position is not a caller); an export that
//      returns a RunResult is a runtime entry and is reported as one, because a runtime with no caller never runs;
//   2. a stage in STAGES has a family with no downstream and no stated reason it ends, or does not hand to the next stage (src/core/harness/data/families.json);
//   3. a surface reader (src/features/<module>/read|server|queries) reads a table that nothing writes: a page-local engine, or data nobody produces. The writers are derived (scripts/ci/connections/tables.mjs): write chains,
//      write helpers, rpcs and trigger functions whose SQL writes the table, seeds, the Edge Function; there is no hand list of written tables;
//   4. a column of the singleton settings table (system_state) is read by nothing or written by nothing: a setting nobody honours, or one nobody can change;
//   5. an API route (src/app/api/**/route.ts) is named by no code, script or workflow: nothing calls it;
//   6. a `*Deps` interface declares a function member optional: a runtime's downstream cannot be left out by omission, it is required in the type (an absent one is a typed `null`, handled by the caller).
// The tree has dead exports, uncalled routes and optional deps today. scripts/ci/connections-allow.json names each one with its reason (`node scripts/ci/connections.mjs --write-allow` rewrites the export list from the
// tree): a new offender is a red run, an entry that is no longer an offender is a red run too (delete it), so the list only shrinks. It prints the connection map into the job summary: the living version of ASSEMBLY D.1.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import ts from "typescript";

import { isMain, walk } from "../lib/fs.mjs";

import { dbCallsOf } from "./db-calls.mjs";
import { buildGraph } from "./connections/graph.mjs";
import { readerReads, rpcNames, tableWriters } from "./connections/tables.mjs";

export const ALLOW_FILE = "scripts/ci/connections-allow.json";
const NEXT_FILES = /^src\/app\/|^src\/instrumentation\.ts$/;
const isReader = (f) => /^src\/features\/[^/]+\/(read|server|queries)\//.test(f);
const isRoot = (f) => NEXT_FILES.test(f) || f.startsWith("scripts/") || f.startsWith("supabase/functions/");

const textsOf = (paths) => new Map(paths.map((p) => [p, readFileSync(p, "utf8")]));

/** Exports with no caller (value exports only; a re-export is judged where it is defined). Returns [{ file, name, line, runtime }]. */
export function deadExports(graph, srcPaths, runtimeNames) {
  const live = graph.reachable([...graph.files].filter(isRoot));
  const dead = [];
  for (const f of srcPaths) {
    if (NEXT_FILES.test(f)) continue;
    for (const [name, e] of graph.info.get(f).exports) {
      if (e.kind !== "value") continue;
      const d = graph.defining(f, name);
      if (!d || d[0] !== f) continue;
      const users = [...(graph.usedBy.get(`${f}#${name}`) ?? [])].filter((u) => u !== f && live.has(u));
      if (!users.length) dead.push({ file: f, name, line: e.line, runtime: runtimeNames.has(`${f}#${name}`) });
    }
  }
  return dead;
}

/** `file#name` of the exported functions whose declared return type is a RunResult (or a type that extends it). */
export function runtimeEntries(srcTexts) {
  const resultTypes = new Set(["RunResult"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const text of srcTexts.values()) {
      for (const m of text.matchAll(/export (?:type|interface) (\w+)(?:<[^>]*>)?\s*(?:=|extends)\s*([^;{]*)/g)) {
        if (!resultTypes.has(m[1]) && [...resultTypes].some((t) => new RegExp(`\\b${t}\\b`).test(m[2]))) {
          resultTypes.add(m[1]);
          grew = true;
        }
      }
    }
  }
  const names = new Set();
  for (const [file, text] of srcTexts) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.type && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && [...resultTypes].some((t) => new RegExp(`\\b${t}\\b`).test(st.type.getText(sf)))) names.add(`${file}#${st.name.text}`);
    }
  }
  return names;
}

/** Stage handoff: every stage has a family that ends or hands on, and hands to the next stage. */
export function stageProblems(stages, families) {
  const problems = [];
  for (const s of stages) {
    const fam = families.find((f) => f.stage === s);
    if (!fam) problems.push(`stage ${s} has no family in families.json`);
    else if (!fam.downstream.length && !fam.terminal) problems.push(`stage ${s} (family ${fam.name}) records no downstream and no reason it ends`);
  }
  for (const [a, b] of stages.slice(0, -1).map((s, i) => [s, stages[i + 1]])) {
    const [fa, fb] = [families.find((f) => f.stage === a), families.find((f) => f.stage === b)];
    if (fa && fb && !fa.downstream.includes(fb.name)) problems.push(`stage ${a} does not hand off to the next stage ${b}: ${fa.name} lists [${fa.downstream}]`);
  }
  return problems;
}

/** Surface readers of tables nothing writes. */
export function tableProblems(reads, writers) {
  return [...reads].filter(([t]) => !writers.has(t)).map(([t, by]) => ({ key: t, text: `${[...new Set(by)].join(", ")}: reads ${t}, which no machine stage, route, rpc, trigger or seed writes (a page-local engine, or data nobody produces)` }));
}

/** Columns an `UPDATE system_state SET ...` assigns inside a SQL function that some code calls through `.rpc`. */
export function rpcSettingWrites(sqlTexts, rpcCalled) {
  const written = new Set();
  for (const sql of sqlTexts) {
    for (const fn of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi)) {
      if (!rpcCalled.has(fn[1])) continue;
      for (const u of fn[3].matchAll(/UPDATE\s+(?:public\.)?system_state\s+SET([\s\S]*?)(?:\bWHERE\b|;)/gi)) for (const a of u[1].matchAll(/(\w+)\s*=/g)) written.add(a[1]);
    }
  }
  return written;
}

/** Columns of system_state that no code reads or no code writes (a write through a SQL function the code calls counts). */
export function settingProblems(srcTexts, columns, sqlWritten = new Set()) {
  const read = new Set();
  const written = new Set(sqlWritten);
  for (const [path, text] of srcTexts) {
    for (const c of dbCallsOf(path, text)) {
      if (c.kind !== "from" || c.name !== "system_state") continue;
      for (const col of (c.select ?? "").split(",").map((x) => x.trim().split(":").pop())) read.add(col);
      for (const f of c.filters) read.add(f.column);
      for (const w of c.writes) for (const k of w.keys) written.add(k);
    }
  }
  const out = [];
  for (const col of columns) {
    if (["id", "created_at", "updated_at"].includes(col)) continue;
    if (!read.has(col)) out.push({ key: `system_state.${col}`, text: `system_state.${col} is a setting nothing reads` });
    if (!written.has(col)) out.push({ key: `system_state.${col}`, text: `system_state.${col} is a setting nothing writes` });
  }
  return out;
}

/** The API route files and the url pattern each serves. */
export const routePattern = (file) => file.replace(/^src\/app/, "").replace(/\/route\.ts$/, "").replace(/\[\.\.\.\w+\]/g, "*").replace(/\[\w+\]/g, "*");

/** API routes named by no text: a literal "/api/..." (template holes become wildcards) that matches the route's segments. */
export function routeProblems(routeFiles, texts) {
  const refs = [];
  for (const text of texts) for (const m of text.matchAll(/["'`]((?:\$\{[^}]*\})?\/(?:api\/)?[^"'`\s?#]*)/g)) if (m[1].startsWith("/api/") || m[1].startsWith("${")) refs.push(m[1].replace(/\$\{[^}]*\}/g, "*").split("/"));
  const same = (a, b) => a === b || (a.includes("*") && new RegExp(`^${a.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(b)) || (b.includes("*") && new RegExp(`^${b.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(a));
  return routeFiles
    .filter((f) => {
      const segs = routePattern(f).split("/");
      const exact = (r) => (r.length === segs.length || (r.at(-1) === "" && r.length - 1 === segs.length)) && segs.every((s, i) => same(r[i] ?? "", s));
      // A reference that begins with a template hole (`${base}/groups/${id}/star`) names the route by its tail.
      const tail = (r) => {
        if (r[0] !== "*" || r.length < 3) return false;
        const rest = r.at(-1) === "" ? r.slice(1, -1) : r.slice(1);
        return rest.length <= segs.length && rest.every((x, i) => same(x, segs[segs.length - rest.length + i]));
      };
      return !refs.some((r) => exact(r) || tail(r));
    })
    .map((f) => ({ key: f, text: `${f}: no code, script or workflow names ${routePattern(f)}: nothing calls this route` }));
}

/** Environment members every runtime defaults (the wall clock and the sleep); R4 gives them one home. They are not downstream runtimes, so an optional one is not an omitted downstream. */
const ENVIRONMENT = new Set(["now", "sleep"]);
/** `*Deps` interface members that are optional functions (the environment members excepted). */
export function optionalDeps(srcTexts) {
  const out = [];
  for (const [file, text] of srcTexts) {
    if (!/Deps\b/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isInterfaceDeclaration(n) && /Deps$/.test(n.name.text)) {
        for (const m of n.members) {
          const fn = (ts.isMethodSignature(m) || (ts.isPropertySignature(m) && m.type && (ts.isFunctionTypeNode(m.type) || (ts.isParenthesizedTypeNode(m.type) && ts.isFunctionTypeNode(m.type.type))))) && m.questionToken;
          if (fn && !ENVIRONMENT.has(m.name.getText(sf))) out.push({ key: `${file}#${n.name.text}.${m.name.getText(sf)}`, text: `${file}:${sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1}: ${n.name.text}.${m.name.getText(sf)} is an optional function: a dependency is required in the type (an absent one is a typed null the caller handles)` });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The allow entries that no longer match an offender: the list only shrinks. */
const staleProblems = (section, allowed, found) => Object.keys(allowed ?? {}).filter((k) => !found.has(k)).map((k) => `${ALLOW_FILE}: ${section} entry ${k} is no longer an offender: delete it`);
const flatExports = (allow) => Object.entries(allow.exports ?? {}).flatMap(([file, names]) => names.map((n) => `${file}#${n}`));

/** Everything the check finds in the tree under the current directory. Returns { problems, map, dead, found } where `found` is the offender keys per section. */
export function connectionProblems() {
  const srcPaths = walk("src", (n) => /\.(ts|tsx)$/.test(n));
  const otherPaths = [...walk("scripts", (n) => /\.mjs$/.test(n)), ...walk("supabase/functions", (n) => /\.ts$/.test(n))];
  const srcTexts = textsOf(srcPaths);
  const otherTexts = textsOf(otherPaths);
  const graph = buildGraph(new Map([...srcTexts, ...otherTexts]));
  const allow = JSON.parse(readFileSync(ALLOW_FILE, "utf8"));
  const problems = [];
  const found = { exports: new Set(), tables: new Set(), settings: new Set(), routes: new Set(), deps: new Set() };

  const runtime = runtimeEntries(srcTexts);
  const dead = deadExports(graph, srcPaths, runtime);
  for (const d of dead) {
    const key = `${d.file}#${d.name}`;
    found.exports.add(key);
    if (!(allow.exports?.[d.file] ?? []).includes(d.name) && !allow.runtimeEntries?.[key]) problems.push(`${d.file}:${d.line}: ${d.name} is ${d.runtime ? "a runtime entry (it returns a RunResult)" : "an export"} with no caller in src, scripts or the Edge Function${d.runtime ? ": a runtime that nothing calls never runs (rule 17)" : ""}`);
  }

  const stages = [...readFileSync("src/core/turn/registry.ts", "utf8").match(/export const STAGES = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const families = JSON.parse(readFileSync("src/core/harness/data/families.json", "utf8"));
  problems.push(...stageProblems(stages, families));

  const sqlTexts = ["supabase/schema.sql", ...walk("supabase/migrations", (n) => /^\d{4}_.+\.sql$/.test(n))].filter(existsSync).map((f) => readFileSync(f, "utf8"));
  const catalog = JSON.parse(readFileSync("tests/_support/schema.json", "utf8")).tables;
  const known = new Set(Object.keys(catalog));
  const writers = tableWriters({ src: new Map([...srcTexts].filter(([f]) => !isReader(f))), other: otherTexts, sqlTexts, known, rpcCalled: rpcNames(new Map([...srcTexts, ...otherTexts])) });
  const reads = readerReads(srcTexts, isReader);
  for (const t of tableProblems(reads, writers)) {
    found.tables.add(t.key);
    if (!allow.tables?.[t.key]) problems.push(t.text);
  }

  const rpcCalled = rpcNames(new Map([...srcTexts, ...otherTexts]));
  for (const s of settingProblems(srcTexts, catalog.system_state?.columns ?? [], rpcSettingWrites(sqlTexts, rpcCalled))) {
    found.settings.add(s.key);
    if (!allow.settings?.[s.key]) problems.push(s.text);
  }

  const routeFiles = srcPaths.filter((f) => /^src\/app\/api\/.*\/route\.ts$/.test(f));
  const referencing = [...srcTexts.values(), ...otherTexts.values(), ...walk(".github/workflows", (n) => /\.ya?ml$/.test(n)).map((f) => readFileSync(f, "utf8"))];
  for (const r of routeProblems(routeFiles, referencing)) {
    found.routes.add(r.key);
    if (!allow.routes?.[r.key]) problems.push(r.text);
  }

  for (const d of optionalDeps(srcTexts)) {
    found.deps.add(d.key);
    if (!allow.deps?.[d.key]) problems.push(d.text);
  }

  problems.push(...flatExports(allow).filter((k) => !found.exports.has(k)).map((k) => `${ALLOW_FILE}: exports entry ${k} is no longer an offender: delete it`));
  for (const section of ["runtimeEntries", "tables", "settings", "routes", "deps"]) {
    const key = section === "runtimeEntries" ? "exports" : section;
    problems.push(...staleProblems(section, allow[section], found[key]));
    for (const [k, reason] of Object.entries(allow[section] ?? {})) if (typeof reason !== "string" || !reason.trim()) problems.push(`${ALLOW_FILE}: ${section} entry ${k} has no reason`);
  }
  if (typeof allow._exports !== "string" || !allow._exports.trim()) problems.push(`${ALLOW_FILE}: the exports list has no reason (_exports)`);

  const map = [
    "### Connection map",
    "",
    "| stage | family | downstream | calls |",
    "|---|---|---|---|",
    ...stages.map((s) => {
      const fam = families.find((f) => f.stage === s);
      const text = [...srcTexts].filter(([f]) => f.startsWith(`src/core/turn/stages/${s}.`)).map(([, t]) => t).join("\n");
      const calls = [...new Set([...text.matchAll(/from "@\/(?:features|core)\/([\w/-]+)"/g)].map((m) => m[1]))].filter((c) => !c.startsWith("harness") && !c.startsWith("types") && !c.startsWith("turn"));
      return `| ${s} | ${fam?.name ?? "?"} | ${fam?.downstream.join(", ") || `ends: ${fam?.terminal ?? "?"}`} | ${calls.join(", ")} |`;
    }),
    "",
    `${dead.length} exports with no caller (${dead.filter((d) => d.runtime).length} runtime entries), ${reads.size} tables read by surface readers, ${routeFiles.length} API routes, ${problems.length} problem(s).`,
  ];
  return { problems, map, dead, found, allow };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { "write-allow": { type: "boolean", default: false } }, strict: true });
  const r = connectionProblems();
  if (values["write-allow"]) {
    const plain = r.dead.filter((d) => !d.runtime);
    const exports = {};
    for (const d of plain.sort((a, b) => (a.file + a.name < b.file + b.name ? -1 : 1))) (exports[d.file] ??= []).push(d.name);
    const runtimeEntries = Object.fromEntries(r.dead.filter((d) => d.runtime).map((d) => [`${d.file}#${d.name}`, r.allow.runtimeEntries?.[`${d.file}#${d.name}`] ?? "a runtime entry with no caller (rule 17): the owning slice wires it into the turn or deletes it"]));
    writeFileSync(ALLOW_FILE, `${JSON.stringify({ ...r.allow, exports, runtimeEntries }, null, 2)}\n`);
    console.log(`${ALLOW_FILE}: ${plain.length} export names in ${Object.keys(exports).length} files, ${Object.keys(runtimeEntries).length} runtime entries`);
    process.exit(0);
  }
  const table = r.map.join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  for (const p of r.problems.slice(0, 60)) console.error(p);
  if (r.problems.length > 60) console.error(`... and ${r.problems.length - 60} more`);
  process.exit(r.problems.length ? 1 : 0);
}
