import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { assertRegistry, REGISTRY } from "@/core/brief/rules";

const stems = (dir: string, suffix: string) => readdirSync(dir).filter((f) => f.endsWith(suffix) && !f.startsWith("_")).map((f) => f.slice(0, -suffix.length)).sort();
const ids = REGISTRY.map((r) => r.id).sort();

test("INV-VAL-1: every rule in rules.json has a rule file and a test, every rule file and every test has a registry row, and the registry holds R1 to R32", () => {
  const files = stems("src/core/brief/rules", ".ts").filter((f) => f !== "index" && f !== "types");
  assert.equal(REGISTRY.length, 32);
  assert.equal(new Set(ids).size, ids.length, "no rule id twice");
  assert.deepEqual(files, ids, "rule files and registry rows are the same set");
  assert.deepEqual(stems("tests/brief/rules", ".test.ts"), ids, "tests and registry rows are the same set");
});

test("INV-VAL-1: the refuse set is exactly the rules that make a claim false or expose internals (R1, R4, R5, R8, R14, R16); every other rule is residue", () => {
  const refuse = REGISTRY.filter((r) => r.severity === "refuse").map((r) => r.id).sort();
  assert.deepEqual(refuse, ["dash-outside-verbatim", "fact-span-in-capture", "fact-span-in-own-section", "no-claim-ledger-json", "score-or-schema-token", "tier-phrase-exposure"]);
});

test("INV-VAL-1: a rule file with no registry row, or a row with no rule file, fails the import", () => {
  assert.doesNotThrow(() => assertRegistry(ids, REGISTRY));
  assert.throws(() => assertRegistry([...ids, "stray-rule"], REGISTRY), /stray-rule has a rule file and no row/);
  assert.throws(() => assertRegistry(ids.slice(1), REGISTRY), new RegExp(`names ${ids[0]} and no rule file`));
});
