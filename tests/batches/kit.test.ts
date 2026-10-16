import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBatch, BATCH_KINDS, chunkByCharBudget, drainExporters, exportBatch, pendingFrom, scratchDir, validateEntries, type EntrySpec } from "@/features/batches";
import { decideDrainSwitch } from "@/core/drain/switch";
import { planDrain, screenVerdictExporter } from "@/features/drain";

import { ITEM, NOW } from "./world.ts";
import { qaWorld, recordWorld, REF, screenWorld } from "./worlds.ts";

test("the kind table is the kit's: seven kinds, each reached by exportBatch and applyBatch, an unknown one refused by name", async () => {
  assert.deepEqual([...BATCH_KINDS], ["record-briefs", "question-answers", "needs-search", "forward-events", "theme-briefs", "screen-verdicts", "ledger-verdicts"]);
  const w = recordWorld();
  assert.match((await exportBatch("mystery", w.deps)).notes[0] ?? "", /unknown batch kind "mystery" \(kinds: record-briefs/);
  assert.match((await applyBatch("mystery", w.deps, { content: "{}", dry: true })).notes[0] ?? "", /unknown batch kind "mystery"/);
});

test("an export goes to a scratch directory and NEVER into the repository; the default directory is outside it; the files are numbered parts under a character budget with the oversize item alone", async () => {
  const w = recordWorld();
  const repoRoot = process.cwd();
  assert.throws(() => scratchDir("record-briefs", { outDir: join(repoRoot, "docs") }), /inside the repository/);
  assert.throws(() => scratchDir("record-briefs", { outDir: "." }), /inside the repository/);
  assert.doesNotThrow(() => scratchDir("record-briefs", { outDir: join(tmpdir(), "caros-x") }));
  assert.doesNotMatch(scratchDir("record-briefs", { runId: "r" }).replace(/\\/g, "/"), new RegExp(`^${repoRoot.replace(/\\/g, "/")}`));
  const dir = mkdtempSync(join(tmpdir(), "caros-kit-"));
  const r = await exportBatch("record-briefs", w.deps, { outDir: dir, charBudget: 1000 });
  assert.equal(r.outcome, "ok", r.notes.join(";"));
  const parts = (r.data as { ids: { parts: string[]; exported_ids: string[] } }).ids;
  assert.equal(parts.parts.length, 1);
  const file = JSON.parse(readFileSync(parts.parts[0] as string, "utf8")) as { oversize?: boolean; items: unknown[] };
  assert.equal(file.oversize, true, "an item over the budget on its own is exported whole, flagged oversize");
  assert.deepEqual(chunkByCharBudget([{ n: "a".repeat(10) }, { n: "b".repeat(10) }, { n: "c".repeat(100) }, { n: "d".repeat(10) }], 40).map((p) => [p.part, p.items.length, p.oversize ?? false]), [[1, 2, false], [2, 1, true], [3, 1, false]]);
  assert.deepEqual(chunkByCharBudget([], 10), []);
});

test("a record export by explicit ids reaches a quarantined item and names every id it cannot export with its reason; the default scope is verified record-grade stubs only", async () => {
  const w = recordWorld();
  const ARCH = "a0000000-0000-4000-8000-0000000000b1";
  w.db.seed("intelligence_items", [{ id: ARCH, title: "Gone", item_type: "market_signal", item_grade: "record", provenance_status: "verified", is_archived: true, source_id: null, source_url: null, full_brief: null }]);
  const dir = mkdtempSync(join(tmpdir(), "caros-kit-ids-"));
  const r = await exportBatch("record-briefs", w.deps, { outDir: dir, ids: [ITEM, ARCH, "a0000000-0000-4000-8000-0000000000ff"] });
  const part = JSON.parse(readFileSync(((r.data as { ids: { parts: string[] } }).ids.parts[0]) as string, "utf8")) as { residue: { id: string; reason: string }[]; items: { id: string }[] };
  assert.deepEqual(part.items.map((i) => i.id), [ITEM]);
  assert.deepEqual(part.residue.map((x) => [x.id === ARCH ? "archived-id" : "other", x.reason]).sort(), [["archived-id", "archived"], ["other", "not_found"]]);
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).provenance_status = "quarantined";
  const byId = await exportBatch("record-briefs", w.deps, { outDir: dir, ids: [ITEM] });
  assert.equal(byId.counts.exported, 1, "a named quarantined item is exported (it is resolved, never left)");
  const auto = await exportBatch("record-briefs", w.deps, { outDir: dir });
  assert.equal(auto.counts.exported, 0, "the default scope does not reach a quarantined item");
});

test("the brief queue is exported minus applied, from the ledger rows alone: ids and part paths, no pool text; an apply row retires its ids", () => {
  const row = (id: string, at: string, ids: Record<string, string[]>) => ({ id, started_at: at, outcome: "success", mode: "apply", outputs: { ids } });
  const rows = [
    row("r3", "2026-10-15T03:00:00Z", { applied_ids: ["a"] }),
    row("r2", "2026-10-15T02:00:00Z", { exported_ids: ["b", "c"], parts: ["/tmp/p2.json"] }),
    row("r1", "2026-10-15T01:00:00Z", { exported_ids: ["a", "b"], parts: ["/tmp/p1.json"] }),
  ];
  assert.deepEqual(pendingFrom(rows), [{ runId: "r1", exportedAt: "2026-10-15T01:00:00Z", ids: ["b"], parts: ["/tmp/p1.json"] }, { runId: "r2", exportedAt: "2026-10-15T02:00:00Z", ids: ["b", "c"], parts: ["/tmp/p2.json"] }]);
  assert.deepEqual(pendingFrom([]), []);
  assert.deepEqual(pendingFrom([{ id: "x", started_at: "t", outcome: "failed", mode: "apply", outputs: null }]), []);
});

test("the judgement drain consumes the SAME exporters: planDrain over drainExporters plans the open question and the held ambiguous row, keyed by the drain's own kind ids", async () => {
  const w = qaWorld();
  w.db.seed("census_worklist", screenWorld().db.rows("census_worklist"));
  const ex = drainExporters(w.deps);
  assert.deepEqual(Object.keys(ex).sort(), ["ledger-verdicts", "needs-search", "question-answers", "record-briefs", "screen-verdict", "theme-briefs"]);
  assert.deepEqual((await ex["screen-verdict"]!({ limit: 10, mode: "pending" })).items, (await screenVerdictExporter(w.db.client)({ limit: 10, mode: "pending" })).items, "the drain's screen-verdict queue IS the kit's screen-verdicts export");
  const plan = await planDrain({
    readSwitch: async () => decideDrainSwitch({ judgementDrain: "on", emergencyPaused: false, fleetHalted: false }),
    exporters: ex, listBatchDir: () => [], acquire: async () => ({ acquired: true, cur_holder: "h" }), release: async () => true, now: () => NOW,
  }, { runId: "run-1", limit: 10, kindId: "question-answers", dry: true });
  const qa = plan.kinds[0];
  assert.deepEqual([qa?.kind, qa?.pending_exported, qa?.export_error, qa?.batches[0]?.item_ids], ["question-answers", 1, null, [REF]]);
});

test("the one validator pattern: a repeated key in a batch is refused once, the structural check runs first, and the pure validation needs no database", () => {
  const spec: EntrySpec<null, number> = { kind: "x", batchRe: /^x-1$/, keyOf: (e) => (typeof e.k === "string" ? e.k : null), load: async () => null, entry: (e) => ((e as { bad?: boolean }).bad ? { errors: ["bad one"] } : { errors: [], plan: 1 }), write: async () => ({ ref: "r" }) };
  const v = validateEntries(spec, { batch: "x-1", generated_at: NOW.toISOString(), authored_by: "session-lane", entries: [{ k: "a" }, { k: "a" }, { k: "b", bad: true }, { k: "c" }] }, null);
  assert.deepEqual([v.valid.map((x) => x.key), v.refused.map((x) => x.key), v.refused[0]?.errors], [["a", "c"], ["a", "b"], ["entry 1 (a): duplicate key in this batch"]]);
  assert.equal(validateEntries(spec, { batch: "y" }, null).fileErrors.length, 4);
});
