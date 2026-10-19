// The gate inventory: every thing in this repository that is a gate, named once. A gate is (1) an npm script the `gates` list runs (scripts/ci/gates.mjs STEPS), (2) the schema job (`schema:apply`),
// (3) a property check (scripts/ci/checks/<key>.sql, and the checks written as scripts, scripts/ci/checks/<key>.mjs: the generator pins and the MemDb conformance), (4) a migration self-check (the id each migration declares on its `-- Self-check <id>` line).
// The mutants registry (tests/mutants/registry.json) must hold at least one mutant for every name returned here, and a mutant for a name that is not here is stale: scripts/ci/mutants/registry.mjs enforces both.
import { readdirSync, readFileSync } from "node:fs";

import { applyNotes, migrationFiles, selfCheckIdOf } from "../../lib/migrations.mjs";
import { STEPS } from "../gates.mjs";

/** The gates run by `npm run gates`, plus the schema job: npm script names. */
export const SCRIPT_GATES = [...STEPS.map((s) => s.cmd), "schema:apply"];

/** Run time classes. `fast` runs on every pull request; `slow` (a bundle, a build) when the sources it reads changed; `schema` needs a database and runs when supabase/ or scripts/ci changed. */
export const SLOW_GATES = new Set(["build", "edge-bundle"]);
export const classOf = (gate) => (gate === "schema:apply" || gate.startsWith("property:") || gate.startsWith("selfcheck:") ? "schema" : SLOW_GATES.has(gate) ? "slow" : "fast");

/** The `property:<key>` gates of the property checks on disk: one per .sql and one per .mjs. */
export function propertyGates(root = ".") {
  return [...readdirSync(`${root}/scripts/ci/checks`).filter((f) => f.endsWith(".sql")).map((f) => `property:${f.slice(0, -4)}`), ...readdirSync(`${root}/scripts/ci/checks`).filter((f) => f.endsWith(".mjs")).map((f) => `property:${f.slice(0, -4)}`)].sort();
}

/** The `selfcheck:<id>` gates: one per migration file, named by its id (lib/migrations.mjs selfCheckIdOf). A file whose check lives in a later file (apply-notes `selfCheckBy`) has none: the later file's gate is the one. */
export function selfCheckGates(root = ".") {
  const dir = `${root}/supabase/migrations`;
  const notes = applyNotes(dir);
  return migrationFiles(dir).filter((f) => !notes[f.replace(/\.sql$/, "")]?.selfCheckBy).map((f) => `selfcheck:${selfCheckIdOf(readFileSync(`${dir}/${f}`, "utf8"), f)}`);
}

export function gateInventory(root = ".") {
  return [...SCRIPT_GATES, ...propertyGates(root), ...selfCheckGates(root)];
}
