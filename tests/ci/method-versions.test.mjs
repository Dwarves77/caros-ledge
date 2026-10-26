import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { walk } from "../../scripts/lib/fs.mjs";
import { currentMethods, DIRS, HASH_FILE, versionProblems } from "../../scripts/ci/method-versions.mjs";

const METHODS = (body, version = '"1"', extra = "") => `
const ID = "double";
const VERSION = ${version};
const FACTOR = 2;
${extra}
const compute = (ctx) => { /* a comment */ return ctx.value * ${body}; };
export function createRegistry(r) {
  r.register("derived_values", ID, VERSION, compute);
}
`;
const files = (text) => new Map([["src/core/propagation/methods.ts", text]]);
const recordedFrom = (text) => Object.fromEntries([...currentMethods(files(text)).methods].map(([k, m]) => [k, m.hash]));

test("a registration is keyed by table, id and version, read through the constants that hold them", () => {
  const { methods, problems } = currentMethods(files(METHODS("FACTOR")));
  assert.deepEqual(problems, []);
  assert.deepEqual([...methods.keys()], ["derived_values:double@1"]);
});

test("the unchanged code passes; a comment or a layout change is not a change", () => {
  const recorded = recordedFrom(METHODS("FACTOR"));
  assert.deepEqual(versionProblems(currentMethods(files(METHODS("FACTOR"))).methods, recorded), []);
  const reflowed = METHODS("FACTOR").replace("/* a comment */", "/* another comment, longer */").replace("{ return", "{\n    return");
  assert.deepEqual(versionProblems(currentMethods(files(reflowed)).methods, recorded), []);
});

test("an export keyword on a helper the method reaches is not part of the method: exporting or unexporting it is not an edit", () => {
  const exported = METHODS("scale()", '"1"', "export function scale() { return 2; }");
  const local = METHODS("scale()", '"1"', "function scale() { return 2; }");
  assert.deepEqual(versionProblems(currentMethods(files(local)).methods, recordedFrom(exported)), []);
  assert.deepEqual(versionProblems(currentMethods(files(exported)).methods, recordedFrom(local)), []);
});

test("planted: a method edit with no version bump fails, naming the key", () => {
  const recorded = recordedFrom(METHODS("FACTOR"));
  const edited = currentMethods(files(METHODS("FACTOR + 1"))).methods;
  assert.match(versionProblems(edited, recorded).join("\n"), /derived_values:double@1: the code its registration runs changed and its version did not/);
});

test("planted: an edit to a helper the method reaches is an edit to the method", () => {
  const recorded = recordedFrom(METHODS("scale()", '"1"', "function scale() { return 2; }"));
  const edited = currentMethods(files(METHODS("scale()", '"1"', "function scale() { return 3; }"))).methods;
  assert.match(versionProblems(edited, recorded).join("\n"), /double@1: the code its registration runs changed/);
});

test("a new version is a new key: it needs a record, and the old key must stay registered", () => {
  const recorded = recordedFrom(METHODS("FACTOR"));
  const bumped = currentMethods(files(METHODS("FACTOR + 1", '"2"'))).methods;
  const found = versionProblems(bumped, recorded).join("\n");
  assert.match(found, /derived_values:double@2 is registered but not recorded/);
  assert.match(found, /derived_values:double@1 is recorded but no longer registered/);
});

test("a registration whose id or version cannot be read is a problem, never a silent skip", () => {
  const dynamic = "export function r(reg, id) { reg.register('derived_values', id, '1', () => 1); }\n";
  assert.match(currentMethods(files(dynamic)).problems.join("\n"), /the key cannot be read/);
});

test("planted: a threshold in a JSON table the method imports is part of the method, and the impact score is a table of the gate (IMPACT-1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "method-json-"));
  mkdirSync(join(dir, "data"));
  const file = join(dir, "methods.ts");
  const code = [
    'import rulesJson from "./data/rules.json";',
    "const RULES = rulesJson;",
    'const ID = "score";',
    'const VERSION = "1";',
    "const compute = (x) => x.value * RULES.factor;",
    'export function r(reg) { reg.register("item_impact_scores", ID, VERSION, compute); }',
  ].join("\n");
  const hashWith = (json) => {
    writeFileSync(join(dir, "data", "rules.json"), json);
    return currentMethods(new Map([[file, code]])).methods;
  };
  const recorded = Object.fromEntries([...hashWith('{"factor": 2}')].map(([k, m]) => [k, m.hash]));
  assert.deepEqual(Object.keys(recorded), ["item_impact_scores:score@1"]);
  assert.deepEqual(versionProblems(hashWith('{ "factor": 2 }'), recorded), [], "the layout of the table is not a change");
  assert.match(versionProblems(hashWith('{"factor": 3}'), recorded).join("\n"), /item_impact_scores:score@1: the code its registration runs changed and its version did not/);
});

test("a recorded key that is no longer registered is a problem unless method-retired.json retires it by name with a registered successor and a reason; a retired key still registered, or never recorded, is a problem too", () => {
  const m = (hash) => ({ hash, where: "methods.ts:1" });
  const recorded = { "t:old@1": "h1", "t:new@2": "h2" };
  const methods = new Map([["t:new@2", m("h2")]]);
  assert.match(versionProblems(methods, recorded).join(" "), /t:old@1 is recorded but no longer registered/);
  const retired = { "t:old@1": { successor: "t:new@2", reason: "the vocabulary the method reads changed; its rows are superseded by the next run" } };
  assert.deepEqual(versionProblems(methods, recorded, retired), []);
  assert.match(versionProblems(new Map(), recorded, retired).join(" "), /t:old@1 is retired in favour of t:new@2, which is not registered/);
  assert.match(versionProblems(new Map([["t:old@1", m("h1")], ["t:new@2", m("h2")]]), recorded, retired).join(" "), /t:old@1 is retired but still registered/);
  assert.match(versionProblems(methods, { "t:new@2": "h2" }, retired).join(" "), /t:old@1 was never recorded/);
  assert.match(versionProblems(methods, recorded, { "t:old@1": { successor: "t:new@2", reason: "short" } }).join(" "), /states no reason/);
});

test("THIS repository: every registered method is recorded and unchanged under its version", () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/ci/method-versions.mjs"], { encoding: "utf8", stdio: "pipe" }));
  assert.ok(Object.keys(JSON.parse(readFileSync(HASH_FILE, "utf8"))).length >= 3);
});

test("INV-CN2-2: the five pattern detectors are registered under the gate, and a threshold edited in patterns.json without a new method version turns it red", () => {
  const treeOf = (root) => new Map(DIRS.flatMap((d) => walk(join(root, d), (n) => /\.ts$/.test(n))).map((f) => [f, readFileSync(f, "utf8")]));
  const real = currentMethods(treeOf("."));
  for (const id of ["pattern_velocity_burst", "pattern_mandate_capacity", "pattern_lead_lag", "pattern_cross_modal", "pattern_penalty_abatement"]) assert.ok(real.methods.has(`derived_values:${id}@${id === "pattern_penalty_abatement" ? "1.4.0" : "1.3.0"}`), `${id} is registered`);
  const recorded = Object.fromEntries([...real.methods].map(([k, m]) => [k, m.hash]));
  assert.deepEqual(versionProblems(real.methods, recorded), []);
  const copyWith = (file, edit) => {
    const root = mkdtempSync(join(tmpdir(), "cn2-"));
    for (const d of DIRS) cpSync(d, join(root, d), { recursive: true });
    writeFileSync(join(root, file), edit(readFileSync(join(root, file), "utf8")));
    return versionProblems(currentMethods(treeOf(root)).methods, recorded).join("\n");
  };
  // one threshold moved (minSources 3 to 4), the version left at 1.3.0
  assert.match(copyWith("src/core/flywheel/patterns/data/patterns.json", (t) => t.replace('"minSources": 3', '"minSources": 4')), /derived_values:pattern_velocity_burst@1.3.0: the code its registration runs changed and its version did not/);
  // a detector edited: the arithmetic of the burst
  assert.match(copyWith("src/core/flywheel/patterns/detect.ts", (t) => t.replace("shareNow <= base.length / inBaseline", "shareNow < base.length / inBaseline")), /pattern_velocity_burst@1.3.0/);
  // the vocabulary a detector reads is part of it: a mode moved in couplings.json
  assert.match(copyWith("src/core/coupling/data/couplings.json", (t) => t.replace(/"modes": \[\s*"road",\s*"ocean"\s*\]/, '"modes": ["road"]')), /pattern_cross_modal@1\.3\.0/);
});
