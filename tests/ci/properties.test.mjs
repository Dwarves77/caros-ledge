import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { appSchemasSql, attackProblems, expectationsOf, judgeRows, waiverShapeProblems } from "../../scripts/ci/properties/judge.mjs";

const waiver = { slice: "P2-X1", date: "2026-10-19", reason: "platform-owned", offenders: ["a.old"] };

test("a waiver names its offenders: the waived row passes, a new row fails, and a new row cannot take the place of a waived one", () => {
  assert.deepEqual(judgeRows("k", [], undefined).status, "PASS");
  assert.deepEqual(judgeRows("k", ["a.old"], waiver).status, "WAIVED");
  const replaced = judgeRows("k", ["a.new"], waiver);
  assert.equal(replaced.status, "FAIL");
  assert.match(replaced.problems.join("\n"), /a\.new \(not waived: a new offender\)/);
  assert.match(replaced.problems.join("\n"), /waiver names "a\.old", which the check no longer returns: delete it/);
  assert.equal(judgeRows("k", ["a.old", "a.extra"], waiver).status, "FAIL", "a count of one would have passed this");
  assert.equal(judgeRows("k", ["a.old"], undefined).status, "FAIL", "no waiver: any offender fails");
});

test("the waiver file is checked: a count, a missing reason, a bad slice and a check that does not exist are each a problem", () => {
  assert.deepEqual(waiverShapeProblems({ k: waiver }, ["k"]), []);
  assert.match(waiverShapeProblems({ k: { ...waiver, offenders: undefined, baseline: 3 } }, ["k"]).join("\n"), /a count is not a waiver/);
  assert.match(waiverShapeProblems({ k: { ...waiver, reason: "" } }, ["k"]).join("\n"), /needs a reason/);
  assert.match(waiverShapeProblems({ k: { ...waiver, slice: "later" } }, ["k"]).join("\n"), /needs slice/);
  assert.match(waiverShapeProblems({ gone: waiver }, ["k"]).join("\n"), /there is no such check/);
});

test("a fixture says what each branch returns: a missing expectation, a branch removed from the fixture and an unexplained row each fail the attack", () => {
  const fixture = "-- expect: anon holds INSERT on public.t\n-- expect: anon SELECT without an anon policy: public.t\nCREATE TABLE public.t (id int);\n";
  const both = ["anon holds INSERT on public.t", "anon SELECT without an anon policy: public.t"];
  assert.deepEqual(attackProblems("k", fixture, both, []), []);
  assert.deepEqual(attackProblems("k", fixture, [...both, "live"], ["live"]), [], "a row the live database already returned is not the fixture's");
  assert.match(attackProblems("k", fixture, [both[0]], []).join("\n"), /did not produce a row starting "anon SELECT without an anon policy: public.t"/);
  assert.match(attackProblems("k", fixture, [...both, "something else"], []).join("\n"), /produced a row it does not expect: something else/);
  assert.match(attackProblems("k", "CREATE TABLE public.t (id int);\n", both, []).join("\n"), /lists no `-- expect:` line/);
  assert.match(attackProblems("k", null, [], []).join("\n"), /no planted violation/);
});

test("the schemas the app reads are every schema that is not the platform's, public included, as one array expression evaluated where it is used", () => {
  const sql = appSchemasSql(["auth", "public", "storage"]);
  assert.match(sql, /nspname <> ALL \(ARRAY\['auth', 'storage'\]::name\[\]\)/);
  assert.doesNotMatch(sql, /'public'/, "public is never excluded");
  assert.match(sql, /\)::name\[\]$/, "the cast keeps = ANY (...) from reading it as a subquery");
});

test("every property check on disk reads the app's schemas and every fixture lists an expectation per branch", () => {
  for (const f of readdirSync("scripts/ci/checks").filter((n) => n.endsWith(".sql"))) {
    if (f === "derivation-input-outbox.sql") continue; // it reads one constraint of one public table, by design
    assert.match(readFileSync(`scripts/ci/checks/${f}`, "utf8"), /\{\{schemas\}\}/, `${f} is bound to public alone`);
  }
  for (const f of readdirSync("scripts/ci/fixtures").filter((n) => !n.startsWith("data-") && n.endsWith(".sql"))) {
    assert.ok(expectationsOf(readFileSync(`scripts/ci/fixtures/${f}`, "utf8")).length >= 1, `${f} lists no expectation`);
  }
});
