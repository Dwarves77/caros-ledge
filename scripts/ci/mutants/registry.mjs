// The mutants registry: tests/mutants/registry.json AND every tests/mutants/registry/*.json (one shard per lane, named after its slice: r2a.json, r2b.json; sorted by name), each an array of
//   { id, gate, apply: [{ file, find, replace }] | { script, args? } | { transform }, expect: "red", closes: [register ids], scope?: [test files] }
// A mutant is ONE deliberate defect: `apply` edits files of a scratch copy of the tree (the first occurrence of `find` becomes `replace`) or runs a script there, then the gate named by `gate` is run on the copy and
// must go red. `gate` is a name from scripts/ci/mutants/inventory.mjs, or `<kind>:*` for a mutant that applies to every gate of that kind (its `transform` module mutates each one). `scope` narrows the gate `test`
// to the named test files (the planted case of one script). The build fails when a mutant leaves its gate green (scripts/ci/mutants.mjs), when a gate has no mutant, or when an entry is stale: this file's checks.
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { classOf } from "./inventory.mjs";

export const REGISTRY_PATH = "tests/mutants/registry.json";
const SHARD_DIR = "tests/mutants/registry";
export const REGISTER_ID = /^[CDFSWK]:\d+$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

// Where each entry of a loaded registry came from, and the shard problems found while loading: { at: [{ file, i }], files, bad: [problem] }.
const sources = new WeakMap();
/** How many registry files were read into `registry` (registry.json counts; a plain array is one). */
export const registryFiles = (registry) => sources.get(registry)?.files ?? 1;

export function loadRegistry(root = ".") {
  const path = `${root}/${REGISTRY_PATH}`;
  if (!existsSync(path)) throw new Error(`${REGISTRY_PATH} does not exist: no gate has a registered mutant`);
  const registry = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(registry)) throw new Error(`${REGISTRY_PATH} must be an array of mutants`);
  const dir = `${root}/${SHARD_DIR}`;
  const shards = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
  const all = [];
  const at = [];
  const bad = [];
  const take = (file, list) => list.forEach((m, i) => (all.push(m), at.push({ file, i })));
  take(REGISTRY_PATH, registry);
  for (const name of shards) {
    const file = `${SHARD_DIR}/${name}`;
    try {
      const list = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      if (Array.isArray(list) && list.length > 0) take(file, list);
      else bad.push(`${file}: a shard is a non-empty array of mutants`);
    } catch (e) {
      bad.push(`${file}: not valid JSON (${e.message})`);
    }
  }
  sources.set(all, { at, files: 1 + shards.length, bad });
  return all;
}

/** Is `gate` named by an inventory (a name in it, or `<kind>:*` over a kind that has members)? */
export const gateKnown = (gate, inventory) => (gate.endsWith(":*") ? inventory.some((g) => g.startsWith(gate.slice(0, -1))) : inventory.includes(gate));
/** The inventory gates a mutant covers: itself, or every member of its wildcard kind. */
export const covered = (gate, inventory) => (gate.endsWith(":*") ? inventory.filter((g) => g.startsWith(gate.slice(0, -1))) : [gate]);

/** The shape problems of one entry (no file is read). */
export function shapeProblems(m, at) {
  const p = [];
  const where = `${typeof at === "string" ? at : `${REGISTRY_PATH} #${at}`}${m && typeof m.id === "string" ? ` (${m.id})` : ""}`;
  if (!m || typeof m !== "object") return [`${where}: not an object`];
  if (typeof m.id !== "string" || !ID.test(m.id)) p.push(`${where}: id must be lower-case words joined by hyphens`);
  if (typeof m.gate !== "string" || !m.gate) p.push(`${where}: gate is required`);
  if (m.expect !== "red") p.push(`${where}: expect must be "red" (a mutant is a defect the gate must catch)`);
  if (!Array.isArray(m.closes) || m.closes.length === 0 || !m.closes.every((c) => REGISTER_ID.test(c))) p.push(`${where}: closes must list register ids such as K:1 (C core, D data machine, F flywheel, S surfaces, W workspace, K kit)`);
  const a = m.apply;
  const edit = (e) => e && typeof e.file === "string" && typeof e.find === "string" && e.find !== "" && typeof e.replace === "string" && e.find !== e.replace;
  const editList = Array.isArray(a) && a.length > 0 && a.every(edit);
  const script = a && !Array.isArray(a) && typeof a.script === "string" && (a.args === undefined || (Array.isArray(a.args) && a.args.every((x) => typeof x === "string")));
  const transform = a && !Array.isArray(a) && typeof a.transform === "string";
  if (!(editList || script || transform)) p.push(`${where}: apply must be a non-empty list of {file, find, replace} (find non-empty and different from replace), {script, args?} or {transform}`);
  if (transform && !String(m.gate).endsWith(":*") && !String(m.gate).startsWith("selfcheck:")) p.push(`${where}: a {transform} mutant applies to every gate of a kind (\`<kind>:*\`) or to one migration self-check (\`selfcheck:<id>\`)`);
  if (m.scope !== undefined && (m.gate !== "test" || !Array.isArray(m.scope) || m.scope.length === 0)) p.push(`${where}: scope narrows the gate "test" to a list of test files`);
  return p;
}

/** Every problem of the registry against the inventory and the tree under `root`. */
export function registryProblems(registry, inventory, root = ".") {
  const src = sources.get(registry);
  const problems = [...(src?.bad ?? [])];
  const seen = new Map();
  registry.forEach((m, i) => {
    const f = src?.at[i].file ?? REGISTRY_PATH;
    problems.push(...shapeProblems(m, src ? `${f} #${src.at[i].i}` : i));
    if (!m || typeof m.id !== "string") return;
    if (seen.has(m.id)) problems.push(`${f}: duplicate id ${m.id}, also in ${seen.get(m.id)}`);
    else seen.set(m.id, f);
    if (typeof m.gate === "string" && !gateKnown(m.gate, inventory)) problems.push(`${f}: ${m.id} names gate ${m.gate}, which is not a gate (scripts/ci/mutants/inventory.mjs lists them)`);
    for (const e of Array.isArray(m.apply) ? m.apply : []) {
      const path = `${root}/${e.file}`;
      if (!existsSync(path)) problems.push(`${f}: ${m.id} edits ${e.file}, which does not exist`);
      else if (!readFileSync(path, "utf8").replace(/\r\n/g, "\n").includes(e.find)) problems.push(`${f}: ${m.id} is stale: ${e.file} no longer contains the text it replaces`);
    }
    for (const f of [m.apply?.script, m.apply?.transform, ...(m.scope ?? [])]) if (typeof f === "string" && !existsSync(`${root}/${f}`)) problems.push(`${f}: ${m.id} names ${f}, which does not exist`);
  });
  const have = new Set(registry.flatMap((m) => (typeof m?.gate === "string" ? covered(m.gate, inventory) : [])));
  for (const g of inventory) if (!have.has(g)) problems.push(`gate ${g} has no registered mutant: a gate nothing has ever turned red certifies nothing (add one to ${REGISTRY_PATH})`);
  return problems;
}

/** The class a registry entry runs in (inventory.mjs classOf of its gate). */
export const classOfMutant = (m) => classOf(m.gate);
