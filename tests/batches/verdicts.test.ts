import assert from "node:assert/strict";
import { test } from "node:test";

import { CLASSIFY_PROMPT_VERSION } from "@/core/intake";
import { applyBatch } from "@/features/batches";
import { ledgerVerdictsExporter } from "@/features/batches/kinds/ledger-verdicts/apply";
import { reopenRuledHolds } from "@/features/batches/kinds/screen-verdicts/apply";
import { screenVerdictExporter } from "@/features/drain";

import { NOW } from "./world.ts";
import { C1, C2, C3, ledgerFile, ledgerWorld, screenWorld, URL1, URL2, verdict, type World } from "./worlds.ts";

const sv = (census_id: string, verdict: string, basis = "EU emissions regulation: core sustainability scope") => ({ census_id, verdict, basis, reviewer: "t" });
const applyScreen = (w: World, verdicts: unknown[], dry = false) => applyBatch("screen-verdicts", w.deps, { content: JSON.stringify({ verdicts }), dry });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const census = (w: World, id: string) => w.db.rows("census_worklist").find((r) => r.id === id) as Record<string, unknown>;

test("screen verdicts: the held ambiguous rows are the drain's own queue; a ruling lands in screen_verdicts, is read back, and re-admits only the rows it rules", async () => {
  const w = screenWorld();
  const q = await screenVerdictExporter(w.db.client)({ limit: 10, mode: "pending" });
  assert.deepEqual((q.items as { census_id: string }[]).map((i) => i.census_id).sort(), [C1, C2]);
  const dry = await applyScreen(w, [sv(C1, "on_vertical")], true);
  assert.equal(dry.counts.planned, 1);
  assert.equal(w.db.rows("screen_verdicts").length, 0);
  const r = await applyScreen(w, [sv(C1, "on_vertical"), sv(C2, "ambiguous"), sv(C3, "off_vertical"), { census_id: "nope", verdict: "on_vertical", basis: "b" }, sv(C1, "bogus"), sv(C2, "on_vertical", "")]);
  assert.equal(r.counts.applied, 3, notes(r));
  assert.equal(r.counts.refused, 3);
  assert.equal(r.outcome, "partial");
  assert.deepEqual(w.db.rows("screen_verdicts").map((v) => [v.census_id, v.verdict]).sort(), [[C1, "on_vertical"], [C2, "ambiguous"], [C3, "off_vertical"]]);
  assert.deepEqual([census(w, C1).dryrun_disposition, census(w, C1).hold_reason], ["would_mint", null], "a ruled hold is re-admitted so the mint re-screens it with the reviewed verdict");
  assert.equal(census(w, C2).dryrun_disposition, "hold", "a verdict that stays ambiguous re-admits nothing");
  assert.equal(census(w, C3).dryrun_disposition, "hold", "an off-vertical hold stays held (it was not an ambiguous one)");
  assert.equal(r.counts.reopened, 1);
  assert.deepEqual(await reopenRuledHolds(w.db.client, [C1, C3], NOW.toISOString()), { matched: 0, written: 0, failures: [] }, "a second reopen finds nothing held");
  assert.match(notes(await applyBatch("screen-verdicts", w.deps, { content: "{}", dry: false })), /no verdicts array/);
});

// ---- the ledger verdict file -----------------------------------------------------------------------------------------------------
const applyLedger = (w: World, file: unknown, dry = false, options?: Record<string, unknown>) => applyBatch("ledger-verdicts", w.deps, { content: JSON.stringify(file), dry, ...(options ? { options } : {}) });

test("ledger verdicts: the candidates owed a verdict are exported; the verdict file is validated whole, then consumed: a verdict classifies, mints at record grade and stamps, no verdict stays owed", async () => {
  const w = ledgerWorld();
  const ex = await ledgerVerdictsExporter(w.deps)({ limit: 10 });
  assert.equal(ex.ok, true);
  assert.equal(ex.current_prompt_version, CLASSIFY_PROMPT_VERSION);
  assert.deepEqual((ex.items as { candidate_id: string; fetch_ok: boolean; fetch_error: string }[]).map((i) => [i.candidate_id, i.fetch_ok, i.fetch_error]), [["p-10", false, "fetch held: the scrape gate is closed"], ["p-11", false, "fetch held: the scrape gate is closed"]]);
  const dry = await applyLedger(w, ledgerFile([verdict(URL1)]), true);
  assert.equal(dry.counts.classified, 1, notes(dry));
  assert.ok(w.db.rows("portal_link_candidates").every((r) => r.status === "candidate"), "a dry apply stamps nothing");
  const r = await applyLedger(w, ledgerFile([verdict(URL1)]));
  assert.equal(r.counts.promoted, 1, notes(r));
  assert.equal(r.counts.verdicts_owed, 1, "the candidate with no verdict is owed");
  assert.equal(w.db.rows("portal_link_candidates").find((c) => c.id === "p-10")?.status, "promoted");
  assert.equal(w.db.rows("portal_link_candidates").find((c) => c.id === "p-11")?.status, "candidate");
  assert.equal(w.rec.mints.filter((m) => !m.dry).length, 1, "minted through the one chokepoint");
  assert.equal(((r.data as { ids: Record<string, string[]> }).ids.minted_item_ids)?.length, 1);
});

test("ledger verdicts: a structural defect refuses the WHOLE file; a verdict under another prompt version is excluded and counted, never accepted", async () => {
  const w = ledgerWorld();
  for (const bad of [ledgerFile([verdict(URL1, { classified_by: "someone" })]), ledgerFile([verdict(URL1, { item_type: null })]), ledgerFile([verdict(URL1)], { prompt_version: "v1" }), ledgerFile([verdict(URL1)], { entries: "x" })]) {
    const r = await applyLedger(w, bad);
    assert.equal(r.outcome, "failed");
    assert.equal(r.counts.file_refused, 1);
  }
  assert.equal(w.rec.mints.length, 0);
  const stale = await applyLedger(w, ledgerFile([verdict(URL1, { prompt_version: "sha256:0000000000000000" }), verdict(URL2)]));
  assert.equal(stale.counts.stale_prompt_version, 1);
  assert.equal(stale.counts.promoted, 1);
  assert.equal(w.db.rows("portal_link_candidates").find((c) => c.id === "p-10")?.status, "candidate", "the stale verdict classified nothing");
  assert.match(notes(stale), /under another prompt version were excluded/);
});
