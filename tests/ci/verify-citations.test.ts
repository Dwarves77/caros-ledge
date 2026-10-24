// CITE-1: a citation of a path, a line range or a table.column the tree does not have is a failure (INV-CITE-1 the phantom path, INV-CITE-2 the phantom column).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { loadSchema } from "../../scripts/ci/columns.mjs";
// @ts-expect-error plain .mjs module
import { extractColumnCitations, extractPathCitations, verify } from "../../scripts/ci/verify-citations.mjs";

type Failure = { doc: string; docLine: number; kind: string; text: string; reason: string };
const schema: Map<string, Set<string>> = loadSchema({ sqlFiles: [] }).tables;
const fixture = (name: string) => `tests/_fixtures/citations/${name}.md`;
const run = (name: string, allow: string[] = []) => verify({ files: [fixture(name)], root: ".", schema, allow }) as { failures: Failure[]; checked: { paths: number; columns: number } };

test("INV-CITE-1: a phantom path is one failure of kind path", () => {
  const { failures } = run("a-phantom-path");
  assert.deepEqual(failures.map((f) => [f.kind, f.text, f.docLine]), [["path", "src/features/scoring/engine.ts", 1]]);
});

test("INV-CITE-2: a phantom column of a real table is one failure of kind column; an allow entry silences exactly that text", () => {
  const { failures } = run("b-phantom-column");
  assert.deepEqual(failures.map((f) => [f.kind, f.text]), [["column", "obligation_objects.next_step_date"]]);
  assert.deepEqual(run("b-phantom-column", ["obligation_objects.next_step_date"]).failures, []);
});

test("a real path with a line range outside the file is one failure", () => {
  const { failures } = run("c-line-range");
  assert.deepEqual(failures.map((f) => [f.kind, f.text]), [["path", "scripts/ci/gates.mjs:99999"]]);
});

test("a real path, an in-range line range and a real column pass; a non-table token and a file name are not columns", () => {
  const result = run("d-clean");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checked, { paths: 2, columns: 1 });
});

test("the old tree, a glob and a placeholder are skipped, not checked", () => {
  const result = run("e-skipped");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checked, { paths: 0, columns: 0 });
});

test("the grammar: .tsx is not read as .ts, a range is read as numbers, a path inside a longer path or a URL is not a citation, a call is not a column", () => {
  assert.deepEqual(extractPathCitations("(src/a/b.tsx:3-9) x"), [{ path: "src/a/b.tsx", lineStart: 3, lineEnd: 9, docLine: 1 }]);
  assert.deepEqual(extractPathCitations("https://x.io/src/a.ts and ../docs/a.md"), []);
  assert.deepEqual(extractColumnCitations("sources.map(x) and sources.url and src/core/sources.ts"), [{ table: "sources", column: "url", docLine: 1 }]);
});

test("the CLI exits 1 on a phantom and prints doc:line, kind, text and reason; it exits 0 on a clean document and on the repo defaults", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/ci/verify-citations.mjs", ...args], { encoding: "utf8" });
  const red = cli("--docs", fixture("a-phantom-path"));
  assert.equal(red.status, 1);
  assert.match(red.stderr, /a-phantom-path\.md:1 {2}path {2}src\/features\/scoring\/engine\.ts {2}no such file/);
  assert.match(red.stdout, /^citations: 1 paths, 0 columns checked, 1 failures$/m);
  assert.equal(cli("--docs", fixture("d-clean")).status, 0);
  assert.equal(cli().status, 0);
});
