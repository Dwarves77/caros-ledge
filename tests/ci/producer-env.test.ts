// The turn job's producer_env step: only NAME_ENABLED=1 pairs reach $GITHUB_ENV, and anything else fails the step. The test runs the workflow's own script under bash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
const block = /- name: Producer kill switches \(this run only\)\n[\s\S]*?run: \|\n((?: {10}.*\n)+)/.exec(workflow);
const script = (block?.[1] ?? "").replace(/^ {10}/gm, "");

function run(producerEnv: string): { status: number | null; env: string } {
  const dir = mkdtempSync(join(tmpdir(), "producer-env-"));
  const file = join(dir, "github_env");
  writeFileSync(file, "");
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, PRODUCER_ENV: producerEnv, GITHUB_ENV: file }, encoding: "utf8" });
  return { status: r.status, env: readFileSync(file, "utf8") };
}

test("the dispatch input exists and the step is in the turn job before the turn runs", () => {
  assert.match(workflow, /\n {6}producer_env:\n {8}description: '[^']*comma-separated NAME=1 pairs for producer kill switches, this run only/);
  assert.ok(script.includes("GITHUB_ENV"), "the step was found");
  assert.ok(workflow.indexOf("Producer kill switches (this run only)") < workflow.indexOf("- name: Turn\n"), "before the Turn step");
});

test("producer_env: valid NAME_ENABLED=1 pairs (spaces allowed, empty items skipped) are appended; an empty input appends nothing", () => {
  assert.deepEqual(run("MARKET_PRODUCER_ECB_FX_ENABLED=1, OEM_PRODUCER_ROWS_FILE_ENABLED=1,"), { status: 0, env: "MARKET_PRODUCER_ECB_FX_ENABLED=1\nOEM_PRODUCER_ROWS_FILE_ENABLED=1\n" });
  assert.deepEqual(run(""), { status: 0, env: "" });
});

test("producer_env: anything else fails the step and appends nothing from the bad pair onward (a value other than 1, a name not ending _ENABLED, lower case, an injected line, a second assignment)", () => {
  for (const bad of ["MARKET_PRODUCER_ECB_FX_ENABLED=0", "MARKET_PRODUCER_ECB_FX_ENABLED=true", "SUPABASE_SERVICE_ROLE_KEY=1", "market_producer_enabled=1", "A_ENABLED=1\nSECRET=1", "A_ENABLED=1=2", "=1", "PATH=/x_ENABLED=1"]) {
    const r = run(`OK_ENABLED=1,${bad}`);
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.ok(!r.env.includes("SECRET") && !r.env.includes("PATH"), JSON.stringify(bad));
  }
});
