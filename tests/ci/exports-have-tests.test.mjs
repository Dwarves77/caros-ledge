import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { listProblems, untestedExports } from "../../scripts/ci/untested-exports.mjs";

import list from "./untested-exports.json" with { type: "json" };

/** A tiny tree: src/core/math.ts with two exports, and the tests that name some of them. */
function tree(tests) {
  const dir = mkdtempSync(join(tmpdir(), "untested-"));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("src/core/math.ts", "export const double = (n: number) => n * 2;\nexport const triple = (n: number) => n * 3;\nexport type Pair = [number, number];\n");
  put("src/core/index.ts", 'export { double, triple } from "./math";\n');
  put("src/app/page.tsx", "export default function Page() { return null; }\n");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  for (const [rel, text] of Object.entries(tests)) put(rel, text);
  return dir;
}

test("an export a test imports and uses is tested; the one nobody names is listed; a type and a Next.js file are out of scope", () => {
  const dir = tree({ "tests/math.test.ts": 'import { double } from "../src/core/math";\ndouble(2);\n' });
  assert.deepEqual(untestedExports(dir), { "src/core/math.ts": ["triple"] });
});

test("a test that reaches an export through the barrel that re-exports it counts", () => {
  const dir = tree({ "tests/math.test.ts": 'import { double, triple } from "../src/core";\ndouble(triple(1));\n' });
  assert.deepEqual(untestedExports(dir), {});
});

test("an import that is never used, and a name in a comment or a string, is not a test", () => {
  const dir = tree({ "tests/math.test.ts": '// triple is exercised elsewhere\nimport { double, triple } from "../src/core/math";\nconst note = "double";\ndouble(1);\nvoid note;\n' });
  assert.deepEqual(untestedExports(dir), { "src/core/math.ts": ["triple"] });
});

test("planted: a new export with no test is a problem; an entry that is now tested or gone is a problem too", () => {
  const found = { "src/core/math.ts": ["triple", "quadruple"] };
  assert.match(listProblems(found, { "src/core/math.ts": ["triple"] }).join("\n"), /`quadruple` is exported and no test names it/);
  assert.match(listProblems({}, { "src/core/math.ts": ["triple"] }).join("\n"), /math\.ts#triple is now tested or gone: delete the entry/);
  assert.deepEqual(listProblems(found, found), []);
});

test("THIS repository: every export is tested or named in tests/ci/untested-exports.json, and the list holds nothing that has a test now", () => {
  assert.deepEqual(listProblems(untestedExports(), list.exports), []);
});

test("the files the list names exist (a rename does not leave a dead line behind)", () => {
  assert.deepEqual(Object.keys(list.exports).filter((f) => !existsSync(f)), []);
});
