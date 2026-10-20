import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBatch, drainExporters, exportBatch } from "@/features/batches";
import { planDrain, screenVerdictExporter } from "@/features/drain";

import { ITEM, NOW } from "./world.ts";
import { qaWorld, recordWorld, REF, screenWorld } from "./worlds.ts";

test("the kind table is the kit's: eight kinds, each reached by exportBatch and applyBatch, an unknown one refused by name", async () => {
  const w = recordWorld();
  assert.match((await exportBatch("mystery", w.deps)).notes[0] ?? "", /unknown batch kind "mystery" \(kinds: record-briefs, question-answers, needs-search, forward-events, theme-briefs, screen-verdicts, ledger-verdicts, host-verdicts\)/);
  assert.match((await applyBatch("mystery", w.deps, { content: "{}", dry: true })).notes[0] ?? "", /unknown batch kind "mystery"/);
});

test("an export goes to a scratch directory and NEVER into the repository; the default directory is outside it; the files are numbered parts under a character budget with the oversize item alone", async () => {
  const w = recordWorld();
  const repoRoot = process.cwd();
  for (const outDir of [join(repoRoot, "docs"), "."]) {
    const refused = await exportBatch("record-briefs", w.deps, { outDir });
    assert.equal(refused.outcome, "failed");
    assert.match(refused.notes.join(";"), /inside the repository/);
  }
  const byDefault = await exportBatch("record-briefs", w.deps, { runId: "r" });
  assert.doesNotMatch(((byDefault.data as { ids: { parts: string[] } }).ids.parts[0] as string).replace(/\\/g, "/"), new RegExp(`^${repoRoot.replace(/\\/g, "/")}`));
  const dir = mkdtempSync(join(tmpdir(), "caros-kit-"));
  const r = await exportBatch("record-briefs", w.deps, { outDir: dir, charBudget: 1000 });
  assert.equal(r.outcome, "ok", r.notes.join(";"));
  const parts = (r.data as { ids: { parts: string[]; exported_ids: string[] } }).ids;
  assert.equal(parts.parts.length, 1);
  const file = JSON.parse(readFileSync(parts.parts[0] as string, "utf8")) as { oversize?: boolean; items: unknown[] };
  assert.equal(file.oversize, true, "an item over the budget on its own is exported whole, flagged oversize");
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

test("the judgement drain consumes the SAME exporters: planDrain over drainExporters plans the open question and the held ambiguous row, keyed by the drain's own kind ids", async () => {
  const w = qaWorld();
  w.db.seed("census_worklist", screenWorld().db.rows("census_worklist"));
  const ex = drainExporters(w.deps);
  assert.deepEqual(Object.keys(ex).sort(), ["host-verdicts", "ledger-verdicts", "needs-search", "question-answers", "record-briefs", "screen-verdict", "theme-briefs"]);
  assert.deepEqual((await ex["screen-verdict"]!({ limit: 10, mode: "pending" })).items, (await screenVerdictExporter(w.db.client)({ limit: 10, mode: "pending" })).items, "the drain's screen-verdict queue IS the kit's screen-verdicts export");
  const plan = await planDrain({
    readSwitch: async () => ({ on: true, reason: null, judgementDrain: "on", emergencyPaused: false, fleetHalted: false, readFailed: false }),
    exporters: ex, listBatchDir: () => [], acquire: async () => ({ acquired: true, cur_holder: "h" }), release: async () => true, now: () => NOW,
  }, { runId: "run-1", limit: 10, kindId: "question-answers", dry: true });
  const qa = plan.kinds[0];
  assert.deepEqual([qa?.kind, qa?.pending_exported, qa?.export_error, qa?.batches[0]?.item_ids], ["question-answers", 1, null, [REF]]);
});
