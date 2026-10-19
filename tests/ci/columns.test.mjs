import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSource, checkTree, loadSchema, selectColumns } from "../../scripts/ci/columns.mjs";

const schema = loadSchema();
const msgs = (text) => checkSource(text, schema).map((p) => p.message);

test("the source tree names only columns the database defines (the check the ci job runs)", () => {
  assert.deepEqual(checkTree("src", schema), []);
});

test("a planted violation is caught in every position the check reads: a select literal, a filter, an order, a select bound to a constant, a qb wrapper, a function output, an unknown table", () => {
  assert.deepEqual(msgs('sb.from("intelligence_items").select("id, effective_priority")'), ['table "intelligence_items" has no column "effective_priority" (select)']);
  assert.deepEqual(msgs('sb.from("intelligence_items").select("id").eq("nope", 1).order("zzz")'), ['table "intelligence_items" has no column "nope" (eq)', 'table "intelligence_items" has no column "zzz" (order)']);
  assert.deepEqual(msgs('const C = "id, bogus";\nsb.from("census_worklist").select(C)'), ['table "census_worklist" has no column "bogus" (select)']);
  assert.deepEqual(msgs('qb<R>(sb.from("census_worklist").select("id")).eq("bad_one", 1).order("id")'), ['table "census_worklist" has no column "bad_one" (eq)']);
  assert.deepEqual(msgs('qb(db.from("census_worklist").select("id, bad_two"))'), ['table "census_worklist" has no column "bad_two" (select)']);
  assert.deepEqual(msgs('sb.rpc("get_workspace_recent_changes").select("id, not_returned")'), ['function "get_workspace_recent_changes" has no column "not_returned" (select)']);
  assert.deepEqual(msgs('sb.rpc("get_workspace_recent_changes").select("id, effective_priority")'), [], "effective_priority IS a column of this function's output");
  assert.deepEqual(msgs('sb.from("nope_table").select("id")'), ['.from("nope_table") names a table or view the database does not define']);
});

test("what the check reads and skips: aliases are stripped, embedded relations, stars, casts and json paths are skipped, a hole in a template string is not guessed", () => {
  assert.deepEqual(selectColumns("id, doc:document_url, sources(a,b), *, n::int, data->x, count"), ["id", "document_url", "count"]);
  assert.deepEqual(msgs('sb.from("census_worklist").select("id, doc:document_url, sources(jurisdiction_iso,transport_modes)")'), []);
  assert.deepEqual(msgs("sb.from('census_worklist').select(`id, ${extra}`)"), []);
  assert.deepEqual(msgs('sb.from("census_worklist").select(someVariable).eq(col, 1)'), []);
  assert.deepEqual(msgs('sb.from("census_worklist").select("id").eq("sources.name", 1)'), [], "a dotted column is an embed filter");
  assert.deepEqual(msgs('const note = "sb.from(x)"; sb.from("census_worklist").select("id")'), []);
});

test("a planted file in a tree fails the tree check with its file and line", () => {
  const dir = mkdtempSync(join(tmpdir(), "caros-columns-"));
  mkdirSync(join(dir, "a"), { recursive: true });
  writeFileSync(join(dir, "a", "bad.ts"), 'export const x = 1;\nexport const q = db.from("intelligence_items")\n  .select("id, effective_priority");\n');
  const problems = checkTree(dir, schema);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a\/bad\.ts:3: table "intelligence_items" has no column "effective_priority" \(select\)/);
});

test('K:22: a write payload key, an upsert conflict column, an .or() string, .match keys, an rpc name and an rpc argument key are checked too (a write to a missing column 404s live)', () => {
  assert.deepEqual(msgs('sb.from("census_worklist").insert({ id: 1, typo_one: 2 })'), ['table "census_worklist" has no column "typo_one" (insert)']);
  assert.deepEqual(msgs('sb.from("census_worklist").insert([{ id: 1 }, { typo_two: 2 }])'), ['table "census_worklist" has no column "typo_two" (insert)']);
  assert.deepEqual(msgs('sb.from("census_worklist").update({ typo_three: 1 }).eq("id", 1)'), ['table "census_worklist" has no column "typo_three" (update)']);
  assert.deepEqual(msgs('sb.from("census_worklist").upsert({ id: 1 }, { onConflict: "id,typo_four" })'), ['table "census_worklist" has no column "typo_four" (onConflict)']);
  assert.deepEqual(msgs('sb.from("census_worklist").select("id").or("id.eq.1,typo_five.is.null")'), ['table "census_worklist" has no column "typo_five" (or)']);
  assert.deepEqual(msgs('sb.from("census_worklist").select("id").match({ typo_six: 1 })'), ['table "census_worklist" has no column "typo_six" (match)']);
  assert.deepEqual(msgs('sb.from("census_worklist").insert({ ...base, id: 1 })'), [], 'a spread leaves the payload open: its other keys are read, the spread is not guessed');
  assert.deepEqual(msgs('sb.rpc("no_such_function", { a: 1 })'), ['.rpc("no_such_function") names a function the database does not define']);
  assert.deepEqual(msgs('sb.rpc("get_workspace_recent_changes", { p_typo: 1 })'), ['function "get_workspace_recent_changes" has no parameter "p_typo" (rpc arguments)']);
});

test("a tree with no database call to read fails the tree check: a check that read nothing certifies nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "caros-columns-empty-"));
  writeFileSync(join(dir, "none.ts"), "export const x = 1;\n");
  assert.match(checkTree(dir, schema).join("|"), /no database call was found to check/);
});
