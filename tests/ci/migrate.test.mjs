import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyAll, applyFile, BOOTSTRAP, pendingFromLog, readLog } from "../../scripts/ci/migrate.mjs";

const check = (id) => `-- Self-check ${id}\nDO $$ BEGIN RAISE NOTICE '${id} OK'; END $$;\n`;
const framed = (id, body = "CREATE TABLE t (id int);\n") => `BEGIN;\n${body}${check(id)}COMMIT;\n`;

/** A client that records every statement it is given. `during(sql)` may throw (the database refusing it) and `notices` are what the DO block prints. */
function fakeClient({ during = () => undefined, notices = (sql) => (/^DO\b/i.test(sql) ? [] : []) } = {}) {
  const log = [];
  const listeners = new Set();
  return {
    log,
    on: (_event, fn) => listeners.add(fn),
    removeListener: (_event, fn) => listeners.delete(fn),
    async query(sql, params) {
      log.push(params ? `${sql.split(" (")[0]} ${JSON.stringify(params)}` : sql.replace(/\s+/g, " ").slice(0, 60));
      during(sql);
      for (const message of notices(sql)) for (const fn of listeners) fn({ message });
      return { rows: [] };
    },
  };
}
const printing = (id) => (sql) => (/^DO\b/i.test(sql) ? [`${id} OK`] : []);
const refusing = (pattern, message = "boom", code = "XX000") => (sql) => {
  if (pattern.test(sql)) throw Object.assign(new Error(message), { code });
};

test("a file is recorded in its own transaction: the log row goes in after its self-check printed OK and just before its COMMIT", async () => {
  const c = fakeClient({ notices: printing("0090-x") });
  const r = await applyFile(c, "0090_x.sql", framed("0090-x"));
  assert.equal(r.problem, null);
  const at = (prefix) => c.log.findIndex((l) => l.startsWith(prefix));
  assert.deepEqual([at("BEGIN"), at("DO") > at("CREATE"), at("INSERT INTO public.migration_log") === at("DO") + 1, at("COMMIT") === c.log.length - 1], [0, true, true, true], c.log.join(" | "));
  assert.match(c.log[at("INSERT INTO public.migration_log")] ?? "", /["0090_x.sql","0090-x OK"]$/);
});

test("a file whose self-check raises leaves no log row and no COMMIT: it is rolled back and the error is returned", async () => {
  const c = fakeClient({ during: refusing(/^DO\b/i, "0090-x: the attack passed", "P0001") });
  const r = await applyFile(c, "0090_x.sql", framed("0090-x"));
  assert.match(String(r.problem), /0090_x\.sql: ERROR:  0090-x: the attack passed \[SQLSTATE P0001\]/);
  assert.ok(!c.log.some((l) => l.startsWith("INSERT INTO public.migration_log") || l === "COMMIT"), c.log.join(" | "));
  assert.equal(c.log.at(-1), "ROLLBACK");
});

test("a file whose check prints nothing is not applied: no log row, rolled back, the missing notice named", async () => {
  const c = fakeClient();
  const r = await applyFile(c, "0090_x.sql", framed("0090-x"));
  assert.match(String(r.problem), /did not print "0090-x OK"/);
  assert.ok(!c.log.some((l) => l.startsWith("INSERT INTO public.migration_log") || l === "COMMIT"));
  assert.equal(c.log.at(-1), "ROLLBACK");
});

test("a refused log insert rolls the file back: nothing is committed that the log does not hold", async () => {
  const c = fakeClient({ notices: printing("0090-x"), during: refusing(/^INSERT INTO public\.migration_log/, "permission denied for table migration_log", "42501") });
  const r = await applyFile(c, "0090_x.sql", framed("0090-x"));
  assert.match(String(r.problem), /permission denied for table migration_log \[SQLSTATE 42501\]/);
  assert.ok(!c.log.includes("COMMIT"));
  assert.equal(c.log.at(-1), "ROLLBACK");
});

test("a file with no transaction of its own is wrapped in one by the runner", async () => {
  const c = fakeClient({ notices: printing("0090-x") });
  const r = await applyFile(c, "0090_x.sql", `CREATE TABLE t (id int);\n${check("0090-x")}`);
  assert.equal(r.problem, null);
  assert.deepEqual([c.log[0], c.log.at(-2)?.startsWith("INSERT INTO public.migration_log"), c.log.at(-1)], ["BEGIN", true, "COMMIT"]);
});

test("the run stops at the first file that does not apply and touches nothing after it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  try {
    for (const [name, id] of [["0090_a.sql", "0090-a"], ["0091_b.sql", "0091-b"], ["0092_c.sql", "0092-c"]]) writeFileSync(join(dir, name), framed(id));
    const c = fakeClient({ notices: (sql) => (/^DO\b/i.test(sql) ? [/0091/.test(sql) ? "0091-b OK" : /0090/.test(sql) ? "0090-a OK" : "0092-c OK"] : []), during: refusing(/0091-b/ , "boom") });
    const { results, applied } = await applyAll(c, ["0090_a.sql", "0091_b.sql", "0092_c.sql"], dir);
    assert.deepEqual(applied, ["0090_a.sql"]);
    assert.deepEqual(results.map((x) => [x.file, x.problem === null]), [["0090_a.sql", true], ["0091_b.sql", false]]);
    assert.ok(!c.log.some((l) => /0092/.test(l)), "the third file was never sent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pending files: with no log table only the bootstrap; from the log, the plan's order (schema, then data) without the logged files and without a HOLD row", () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  try {
    for (const name of ["0001_a.sql", "0002_b.sql", "0003_data_c.sql", "0004_d.sql", "0005_e.sql", BOOTSTRAP]) writeFileSync(join(dir, name), framed(name.slice(0, 4)));
    writeFileSync(join(dir, "apply-notes.json"), JSON.stringify({ "0004_d": { hold: "after the duplicate-email query returns no row" }, "0003_data_c": { consumer: "x", after: "0002" } }));
    assert.deepEqual(pendingFromLog(dir, null), [BOOTSTRAP], "no migration_log yet: the bootstrap alone");
    assert.deepEqual(pendingFromLog(dir, new Set(["0001_a.sql"])), ["0002_b.sql", "0005_e.sql", BOOTSTRAP, "0003_data_c.sql"]);
    assert.deepEqual(pendingFromLog(dir, new Set(["0001_a.sql", "0002_b.sql", "0003_data_c.sql", "0005_e.sql", BOOTSTRAP])), [], "everything logged (the HOLD row waits for a person): nothing pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log is read as a set of file names; a missing table is null; any other failure is not swallowed", async () => {
  assert.deepEqual([...(await readLog({ query: async () => ({ rows: [{ file: "0001_a.sql" }, { file: "0002_b.sql" }] }) }))], ["0001_a.sql", "0002_b.sql"]);
  assert.equal(await readLog({ query: async () => { throw Object.assign(new Error('relation "public.migration_log" does not exist'), { code: "42P01" }); } }), null);
  await assert.rejects(readLog({ query: async () => { throw Object.assign(new Error("connection terminated"), { code: "08006" }); } }), /connection terminated/);
});
