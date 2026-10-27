// The dry plan over five pending items through the real exporters of the batch kit (no stand-ins): one item brief, one theme, one open question, one unplaced host and one derived pattern, in one memory database.
import assert from "node:assert/strict";
import { test } from "node:test";

import { drainExporters } from "@/features/batches";

import { runPlanDrain } from "../../scripts/digest/plan-drain.mjs";
import { noPackets, NOW } from "../batches/world.ts";
import { hostWorld, qaWorld, themeWorld, THEME } from "../batches/worlds.ts";

import { cluster } from "./admin-world.ts";

test("a dry plan over five pending items counts them per kind, takes no lease, writes no file and opens no PR", async () => {
  const w = themeWorld();
  w.db.seed("system_state", [{ id: true, global_processing_paused: false, judgement_drain: "on" }]);
  w.db.seed("integrity_flags", qaWorld().db.rows("integrity_flags"));
  w.db.seed("host_worklist", hostWorld().db.rows("host_worklist").slice(0, 1));
  w.db.seed("derived_values", [{ value_id: "d1000000-0000-4000-8000-000000000001", method_id: "pattern_mandate_capacity", method_version: "1.0.0", entity_id: "e1", derivation: "calculated", origin_class: "derived", lifecycle: "emerging", admissibility: "analysis_ok", base_confidence: 0.7, asserted_at: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(), invalidated_at: null }]);
  const lines: string[] = [];
  const written: string[] = [];
  const rpcs: string[] = [];
  const db = Object.assign(w.db.client, { rpc: async (name: string) => (rpcs.push(name), { data: null, error: null }) });
  const code = await runPlanDrain(["--dry", "--run-id", "dry-1"], {
    now: () => NOW,
    makeDb: () => db,
    buildExporters: async () => drainExporters({ ...w.deps, packets: noPackets, assembleClusters: async () => ({ clusters: [cluster()], truncated: 0 }) }),
    listBatchDir: () => [],
    planPath: (id: string) => `/scratch/${id}.json`,
    writePlan: (path: string) => void written.push(path),
    readPlan: () => "",
    log: (l: string) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.match(lines[0] ?? "", /^drain: on \(dry run: nothing written, no lease taken\)\. 5 item\(s\) in 5 batch\(es\) across 5 kind\(s\)/);
  const by = (kind: string) => lines.find((l) => l.startsWith(`  ${kind}:`)) ?? "";
  assert.match(by("item-briefs"), /exported 1, planned 1 in 1 batch\(es\), would lease 1/);
  assert.match(by("theme-briefs"), /exported 1, planned 1 in 1 batch\(es\), would lease 1/);
  assert.match(by("question-answers"), /exported 1, planned 1 in 1 batch\(es\), would lease 1/);
  assert.match(by("host-verdicts"), /exported 1, planned 1 in 1 batch\(es\), would lease 0/);
  assert.match(by("admin-opportunity-findings"), /exported 1, planned 1 in 1 batch\(es\), would lease 0/);
  assert.ok(lines.some((l) => l.includes(`item-briefs-001.json: `)) && THEME);
  assert.deepEqual([written.length, rpcs.filter((r) => /mutation_lease/.test(r)).length], [0, 0]);
  assert.ok(!lines.some((l) => /export error/.test(l)), "only the kinds with an exporter are planned");
});
