import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

test("INV-VAL-5: the report runs in --fixture mode through a gates registration and every rule trips exactly the rows labelled with it", () => {
  assert.equal(pkg.scripts["validator-report"], "node scripts/ci/validator-report.mjs --fixture");
  assert.match(readFileSync("scripts/ci/gates.mjs", "utf8"), /cmd: "validator-report"/, "npm run gates runs it");
  const r = spawnSync(process.execPath, ["scripts/ci/validator-report.mjs", "--fixture"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /validator-report --fixture: \d+ rows, 33 rules, 0 problem\(s\)/);
  assert.doesNotMatch(r.stdout, /MISMATCH|NO FIXTURE ROW/);
});

test("INV-VAL-5: --live is never wired into CI, the gates or the package scripts, and the report refuses both or neither mode", () => {
  const wired = [...Object.values(pkg.scripts), readFileSync("scripts/ci/gates.mjs", "utf8"), ...readdirSync(".github/workflows").map((f) => readFileSync(`.github/workflows/${f}`, "utf8"))];
  assert.equal(wired.some((t) => /validator-report[^\n]*--live|--live[^\n]*validator-report/.test(t)), false);
  for (const args of [[], ["--fixture", "--live"]]) {
    const r = spawnSync(process.execPath, ["scripts/ci/validator-report.mjs", ...args], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: node scripts\/ci\/validator-report\.mjs/);
  }
});
