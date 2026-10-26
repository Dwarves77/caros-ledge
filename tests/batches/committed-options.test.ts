// DRAIN-1: a committed batch file may carry top-level `options` (only keys the kit's applyBatch accepts); applyCommitted passes them through, so allowBriefOverwrite reaches an item that already holds a brief.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyCommitted } from "@/features/batches/committed";

import { batchFile, batchWorld, recordEntry } from "./world.ts";

const commit = (file: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), "caros-opts-"));
  mkdirSync(join(root, "drain/batches/item-briefs"), { recursive: true });
  writeFileSync(join(root, "drain/batches/item-briefs/item-briefs-001.json"), JSON.stringify(file));
  return root;
};

test("a committed item-briefs batch with options.allowBriefOverwrite regenerates a brief-grade item; without options it is refused", async () => {
  const bare = batchWorld({ briefGrade: true });
  const refused = await applyCommitted(bare.deps, { root: commit(batchFile("item-briefs", [recordEntry(bare.db)])), dry: false, runId: "run-1" });
  assert.deepEqual(refused.data?.ids.applied_ids, [], "no options: the overwrite guard holds");

  const w = batchWorld({ briefGrade: true });
  const ok = await applyCommitted(w.deps, { root: commit(batchFile("item-briefs", [recordEntry(w.db)], { options: { allowBriefOverwrite: true } })), dry: false, runId: "run-2" });
  assert.equal(ok.data?.ids.applied_ids.length, 1, ok.notes.join("; "));
});

test("options keys the kit does not accept are not passed on (a committed file cannot set dry or runId)", async () => {
  const w = batchWorld({ briefGrade: true });
  const r = await applyCommitted(w.deps, { root: commit(batchFile("item-briefs", [recordEntry(w.db)], { options: { allowBriefOverwrite: true, dry: true, runId: "forged" } })), dry: false, runId: "run-3" });
  assert.equal(r.data?.ids.applied_ids.length, 1, "dry:true in the file did not make the apply dry");
  assert.equal(w.db.rows("intelligence_items").length > 0 && w.db.writes("intelligence_items").length > 0, true);
});
