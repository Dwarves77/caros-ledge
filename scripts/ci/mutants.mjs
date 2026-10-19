// The mutants job: proves every gate can go red. tests/mutants/registry.json and the shards in tests/mutants/registry/ list deliberate defects (mutants); each is applied to a scratch copy of the tree and the gate it names is run there. A mutant that leaves
// its gate green fails the build (that gate certifies nothing), as does a gate with no mutant and a registry entry that no longer applies.
//
//   node scripts/ci/mutants.mjs --check                     the registry against the gate inventory and the tree (no mutant is run; `npm run gates` runs this)
//   node scripts/ci/mutants.mjs [--classes fast,slow,schema] [--only id,id] [--scratch dir] [--fresh] [--json report.json] [--control]
//
// Classes: fast (every pull request), slow (a bundle or a build: when the sources they read changed), schema (needs a database: DATABASE_URL, else an embedded PostgreSQL 15; when supabase/ or scripts/ci changed).
// Exit 0 every selected mutant went red; 1 a mutant survived, errored, or the registry is wrong.
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

import { STEPS } from "./gates.mjs";
import { gateInventory } from "./mutants/inventory.mjs";
import { classOfMutant, covered, loadRegistry, registryFiles, registryProblems } from "./mutants/registry.mjs";
import { applyMutant, execIn, gateCommand, judge } from "./mutants/run.mjs";
import { prepareScratch, restore } from "./mutants/scratch.mjs";
import { runSchemaMutants } from "./mutants/schema-group.mjs";

const CLASSES = ["fast", "slow", "schema"];

/** Run one non-database mutant in the scratch and return its result row. */
export function runOne(dir, mutant, log = () => undefined) {
  restore(dir);
  const row = { id: mutant.id, gate: mutant.gate, class: classOfMutant(mutant), closes: mutant.closes };
  try {
    applyMutant(dir, mutant);
  } catch (e) {
    return { ...row, verdict: "error", line: `the mutant did not apply: ${e.message}`, seconds: 0 };
  }
  const stepEnv = STEPS.find((s) => s.cmd === mutant.gate)?.env ?? {};
  const { command, args, env } = gateCommand(mutant.gate, { scope: mutant.scope, stepEnv });
  log(`mutant ${mutant.id}: npm gate ${mutant.gate}`);
  const r = execIn(dir, command, args, env);
  restore(dir);
  return { ...row, ...judge(mutant.gate, r), exit: r.code, seconds: Math.round(r.ms / 100) / 10 };
}

/** The table of a run, one line per mutant. */
export function reportTable(rows, seconds) {
  const head = ["| mutant | gate | verdict | s | first red line |", "|---|---|---|---|---|"];
  const lines = rows.map((r) => `| ${r.id} | ${r.gate} | ${r.verdict === "red" ? "red (caught)" : r.verdict.toUpperCase()} | ${r.seconds} | ${String(r.line).replace(/\|/g, "/")} |`);
  const caught = rows.filter((r) => r.verdict === "red").length;
  return [...head, ...lines, "", `${caught} of ${rows.length} mutants turned their gate red; ${rows.length - caught} did not. Runtime ${seconds}s.`].join("\n");
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false }, classes: { type: "string", default: "fast" }, only: { type: "string" }, scratch: { type: "string" }, fresh: { type: "boolean", default: false }, json: { type: "string" }, control: { type: "boolean", default: false } }, strict: true });
  const root = resolve(".");
  const registry = loadRegistry(root);
  const inventory = gateInventory(root);
  const problems = registryProblems(registry, inventory, root);
  for (const p of problems) console.error(p);
  if (values.check) {
    const n = registry.reduce((count, m) => count + (m.gate.endsWith(":*") ? covered(m.gate, inventory).length : 1), 0);
    console.log(problems.length ? `mutants: ${problems.length} problem(s)` : `mutants: ${registry.length} registry entries in ${registryFiles(registry)} file(s) (${n} mutants) cover all ${inventory.length} gates`);
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length && !values.only) process.exit(1); // a targeted run (--only) is for building mutants: the coverage problems are printed above and `--check` is what fails the build
  const classes = values.classes.split(",").map((c) => c.trim());
  const bad = classes.filter((c) => !CLASSES.includes(c));
  if (bad.length) throw new Error(`unknown class(es) ${bad.join(", ")} (classes: ${CLASSES.join(", ")})`);
  const only = values.only ? new Set(values.only.split(",")) : null;
  const selected = registry.filter((m) => classes.includes(classOfMutant(m)) && (!only || only.has(m.id)));
  if (!selected.length) throw new Error("no mutant selected");

  const started = Date.now();
  const dir = resolve(values.scratch ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "caros-mutants"));
  const log = (m) => console.log(m);
  prepareScratch(root, dir, { log, reuse: !values.fresh });
  const rows = [];
  if (values.control) {
    for (const gate of new Set(selected.filter((m) => classOfMutant(m) !== "schema").map((m) => m.gate))) {
      restore(dir);
      const { command, args, env } = gateCommand(gate, { scope: registry.find((m) => m.gate === gate && m.scope)?.scope, stepEnv: STEPS.find((s) => s.cmd === gate)?.env ?? {} });
      const r = execIn(dir, command, args, env);
      console.log(`control ${gate}: ${r.code === 0 ? "green" : `RED on the unmutated tree (${judge(gate, r).line})`}`);
    }
  }
  for (const m of selected.filter((x) => classOfMutant(x) !== "schema")) {
    rows.push(runOne(dir, m, log));
    console.log(`  ${m.id}: ${rows[rows.length - 1].verdict} (${rows[rows.length - 1].line})`);
  }
  const schemaMutants = selected.filter((m) => classOfMutant(m) === "schema");
  if (schemaMutants.length) rows.push(...(await runSchemaMutants({ dir, mutants: schemaMutants, inventory, log })));
  const seconds = Math.round((Date.now() - started) / 1000);
  const table = reportTable(rows, seconds);
  console.log(`\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mutants (${classes.join(", ")})\n\n${table}\n`);
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ classes, seconds, rows }, null, 2)}\n`);
  process.exit(rows.every((r) => r.verdict === "red") ? 0 : 1);
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`mutants: ${e.message}`);
    process.exit(1);
  }
}
