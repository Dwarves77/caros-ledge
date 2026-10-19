// The gate inventory: every thing in this repository that is a gate, named once. A gate is (1) an npm script the `gates` list runs (scripts/ci/gates.mjs STEPS), (2) the schema job (`schema:apply`),
// (3) a property check (scripts/ci/checks/<key>.sql, and the generator pins, which are the one non-SQL property), (4) a migration self-check (the id each migration declares on its `-- Self-check <id>` line).
// The mutants registry (tests/mutants/registry.json) must hold at least one mutant for every name returned here, and a mutant for a name that is not here is stale: scripts/ci/mutants/registry.mjs enforces both.
import { readdirSync, readFileSync } from "node:fs";

import { migrationFiles, selfCheckId } from "../../lib/migrations.mjs";
import { STEPS } from "../gates.mjs";

/** The gates run by `npm run gates`, plus the schema job: npm script names. */
export const SCRIPT_GATES = [...STEPS.map((s) => s.cmd), "schema:apply"];

/** Run time classes. `fast` runs on every pull request; `slow` (a bundle, a build) when the sources it reads changed; `schema` needs a database and runs when supabase/ or scripts/ci changed. */
export const SLOW_GATES = new Set(["build", "edge-bundle"]);
export const classOf = (gate) => (gate === "schema:apply" || gate.startsWith("property:") || gate.startsWith("selfcheck:") ? "schema" : SLOW_GATES.has(gate) ? "slow" : "fast");

/** The `property:<key>` gates of the property checks on disk. */
export function propertyGates(root = ".") {
  return [...readdirSync(`${root}/scripts/ci/checks`).filter((f) => f.endsWith(".sql")).map((f) => `property:${f.slice(0, -4)}`), "property:generator-pins"].sort();
}

/** The `selfcheck:<id>` gates: one per migration file, named by its declared id (a file with none is named by its number, which migration-checks refuses). */
export function selfCheckGates(root = ".") {
  const dir = `${root}/supabase/migrations`;
  return migrationFiles(dir).map((f) => `selfcheck:${selfCheckId(readFileSync(`${dir}/${f}`, "utf8")) ?? f.slice(0, 4)}`);
}

export function gateInventory(root = ".") {
  return [...SCRIPT_GATES, ...propertyGates(root), ...selfCheckGates(root)];
}
