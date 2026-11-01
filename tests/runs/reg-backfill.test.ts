// REG-BACKFILL-1. INV-RB-2: the generator emits N/25 plans with disjoint ids that execute.mjs loads. INV-RB-3: a briefs step whose bundle file is missing is refused as bundle_missing, never a crash and never a failed run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { executePlan, exitCodeOf } from "../../scripts/runs/execute.mjs";
// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";
// @ts-expect-error plain .mjs module
import { batchPlans } from "../../scripts/runs/plan-reg-backfill.mjs";

type Batch = { base: string; ids: { ids: string[] }; plan: unknown };
const ids = Array.from({ length: 60 }, (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

test("INV-RB-2: 60 ids make 3 batches of 25, 25, 10 with disjoint ids, and every plan parses", () => {
  const batches: Batch[] = batchPlans(ids, { date: "2026-11-01" });
  assert.deepEqual(batches.map((b) => b.ids.ids.length), [25, 25, 10]);
  assert.equal(new Set(batches.flatMap((b) => b.ids.ids)).size, 60);
  const dir = mkdtempSync(join(tmpdir(), "rb-"));
  mkdirSync(join(dir, "data"));
  for (const b of batches) {
    const p = parsePlan(JSON.stringify(b.plan), join(dir, `${b.base}.json`));
    assert.deepEqual(p.steps.map((s: { mode: string; on_failure: string }) => [s.mode, s.on_failure]), [["dry", "stop"], ["apply", "stop"]]);
    assert.equal(p.steps[0].input_file, p.steps[1].input_file);
  }
});

test("the committed first batch: 25 distinct ids and a plan that parses", () => {
  const list = JSON.parse(readFileSync("scripts/runs/plans/data/2026-11-01-reg-backfill-1.ids.json", "utf8"));
  assert.equal(list.ids.length, 25);
  assert.equal(new Set(list.ids).size, 25);
  const planPath = "scripts/runs/plans/2026-11-01-reg-backfill-1.json";
  assert.equal(parsePlan(readFileSync(planPath, "utf8"), planPath).steps.length, 2);
});

test("INV-RB-3: a briefs step with a missing input_file is refused as bundle_missing; the turn is never called and the run is not failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-"));
  const planPath = join(dir, "2026-11-01-x.json");
  const step = (name: string, mode: string) => ({ name, stage: "briefs", mode, input_file: "data/none.items.json", producer_env: [] });
  const plan = parsePlan(JSON.stringify({ ruling: "r", steps: [step("d", "dry"), step("a", "apply")] }), planPath);
  const calls: unknown[] = [];
  const r = await executePlan(plan, planPath, { invoke: (c: unknown) => { calls.push(c); return { status: 0, result: { runs: [] } }; } });
  assert.equal(calls.length, 0);
  assert.deepEqual(r.steps.map((s: { outcome: string }) => s.outcome), ["bundle_missing", "bundle_missing"]);
  assert.match(r.steps[1].note, /^bundle_missing: data\/none\.items\.json/);
  assert.equal(exitCodeOf(r), 0);
});

test("INV-RB-3: a missing input_file on any other stage still fails the parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-"));
  assert.throws(() => parsePlan(JSON.stringify({ ruling: "r", steps: [{ name: "c", stage: "connect", mode: "dry", input_file: "data/none.json", producer_env: [] }] }), join(dir, "p.json")), /unreadable/);
});
