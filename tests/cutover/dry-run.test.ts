// The cutover dry run's builder (P2-15g): framing refused unless exact, one step marker per file, one transaction ending in ROLLBACK. No database.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { buildScript, planFiles, stripFraming } from "../../scripts/cutover/dry-run.mjs";

const framed = (body: string) => `-- header\nBEGIN;\n${body}\nCOMMIT;\n`;

test("each file is stripped of its own BEGIN and COMMIT, marked, and the whole ends in ROLLBACK", () => {
  const s: string = buildScript([{ name: "0004_a.sql", text: framed("SELECT 1;") }, { name: "0005_b.sql", text: framed("SELECT 2;") }]);
  assert.equal(s.split("\n")[0], "BEGIN;");
  assert.equal(s.split("\n").at(-1), "ROLLBACK;");
  assert.equal((s.match(/^BEGIN;$/gm) ?? []).length, 1);
  assert.equal((s.match(/COMMIT;/g) ?? []).length, 0);
  assert.ok(s.indexOf("cutover-dry-run: 0004_a.sql") < s.indexOf("SELECT 1;") && s.indexOf("SELECT 1;") < s.indexOf("cutover-dry-run: 0005_b.sql") && s.indexOf("cutover-dry-run: 0005_b.sql") < s.indexOf("SELECT 2;"));
});

test("a file not framed BEGIN; ... COMMIT; is refused, as is one with a transaction statement inside", () => {
  assert.throws(() => stripFraming("x.sql", "SELECT 1;\nCOMMIT;\n"), /not framed/);
  assert.throws(() => stripFraming("x.sql", "BEGIN;\nSELECT 1;\n"), /not framed/);
  assert.throws(() => stripFraming("x.sql", framed("COMMIT;\nSELECT 1;")), /transaction statement/);
  assert.throws(() => buildScript([]), /no files/);
});

test("the plan is the schema files from 0004 minus holds, then the data files", () => {
  const names = ["0003_a.sql", "0004_b.sql", "0005_c.sql", "0006_data_d.sql", "0007_e.sql", "APPLY.md"];
  assert.deepEqual(planFiles(names, { "0007_e": { hold: "x" } }), ["0004_b.sql", "0005_c.sql", "0006_data_d.sql"]);
});
