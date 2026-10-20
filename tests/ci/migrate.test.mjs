import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pendingFiles } from "../../scripts/ci/apply-plan.mjs";
import { applyAll, appliedAfter, runProblem } from "../../scripts/ci/migrate.mjs";

/** A migrations directory: `files` (name to text), the numbers APPLIED.json lists and the apply notes. */
function fixture(files, applied, notes = {}) {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "APPLIED.json"), JSON.stringify({ applied }));
  writeFileSync(join(dir, "apply-notes.json"), JSON.stringify(notes));
  return dir;
}
const check = (id) => `-- Self-check ${id}\nDO $$ BEGIN RAISE NOTICE '${id} OK'; END $$;\n`;

test("the pending files are the plan's order that APPLIED.json does not list: schema in name order, then data, a HOLD row left out", () => {
  const dir = fixture(
    { "0001_a.sql": check("0001-a"), "0002_b.sql": check("0002-b"), "0003_data_c.sql": check("0003-c"), "0004_d.sql": check("0004-d"), "0005_e.sql": check("0005-e") },
    ["0001"],
    { "0004_d": { hold: "after the duplicate-email query returns no row" }, "0003_data_c": { consumer: "x", after: "0002" } },
  );
  try {
    assert.deepEqual(pendingFiles(dir), ["0002_b.sql", "0005_e.sql", "0003_data_c.sql"]);
    assert.deepEqual(pendingFiles(fixture({ "0001_a.sql": check("0001-a") }, ["0001"])), [], "nothing pending is an empty list, not an error");
    assert.deepEqual(appliedAfter(["0002_b.sql"], dir), ["0001_a.sql", "0002_b.sql"], "the applied list is the previous one plus what this run applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file counts as applied only when it exits 0, prints no ERROR and prints its own OK notice: a check that prints nothing fails, an ERROR line is returned", () => {
  const text = check("0070-x");
  assert.equal(runProblem("0070_x.sql", text, { status: 0, stderr: "NOTICE:  0070-x OK\n" }), null);
  assert.match(String(runProblem("0070_x.sql", text, { status: 0, stderr: "" })), /did not print "0070-x OK"/);
  assert.match(String(runProblem("0070_x.sql", text, { status: 0, stderr: "NOTICE:  some other notice\n" })), /did not print "0070-x OK"/);
  assert.equal(runProblem("0070_x.sql", text, { status: 3, stderr: "psql:supabase/migrations/0070_x.sql:4: ERROR:  relation \"t\" does not exist [SQLSTATE 42P01]\n" }), "psql:supabase/migrations/0070_x.sql:4: ERROR:  relation \"t\" does not exist [SQLSTATE 42P01]");
  assert.match(String(runProblem("0070_x.sql", text, { status: 2, stderr: "NOTICE:  0070-x OK\n" })), /exited 2/, "a failed exit is not applied even with the notice");
});

test("the run stops at the first file that does not count as applied and applies nothing after it", () => {
  const dir = fixture({ "0002_a.sql": check("0002-a"), "0003_b.sql": check("0003-b"), "0004_c.sql": check("0004-c") }, []);
  try {
    const ran = [];
    const run = (file) => {
      ran.push(file);
      return file === "0003_b.sql" ? { status: 3, stderr: "ERROR:  boom\n" } : { status: 0, stderr: `NOTICE:  ${file.slice(0, 4)}-${file[5]} OK\n` };
    };
    const { results, applied } = applyAll(["0002_a.sql", "0003_b.sql", "0004_c.sql"], run, dir);
    assert.deepEqual(ran, ["0002_a.sql", "0003_b.sql"]);
    assert.deepEqual(results.map((r) => [r.file, r.problem]), [["0002_a.sql", null], ["0003_b.sql", "ERROR:  boom"]]);
    assert.deepEqual(applied, ["0002_a.sql"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
