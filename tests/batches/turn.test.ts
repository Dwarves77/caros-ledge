// ONE system (operator, 2026-10-16): the briefs stage proven on the output of the fixture turn. The turn mints a regulation from a stored capture; the briefs stage EXPORTS it to a scratch directory, a session authors the
// full brief FROM THAT FILE (its pool text, its pool hash, its required slots), the stage applies it, and the item is a brief with the claims grounded in the capture the turn stored, the queue empty, and the run recorded
// under the turn's root. Nothing is seeded by hand: the item, its pool and its slots are what the machine wrote.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runTurn } from "@/core/turn";

import { fixture, NOW } from "../integration/world.ts";

import { A1, A2, A3, A4, fact, installBriefTrigger, regulatoryBody } from "./regulatory.ts";
import { metadata, withReview } from "./world.ts";

test("the turn mints, the stage exports the stub, a session authors from the exported file, the stage applies it: the item is a brief grounded in the capture the turn stored", async () => {
  const f = fixture();
  installBriefTrigger(f);
  const first = await runTurn({ stage: "all", mode: "apply", input: { intake: { census: { limit: 5 } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(first.exit, 0);
  const minted = f.db.rows("intelligence_items").find((r) => r.item_grade === "record") as Record<string, unknown>;
  assert.equal(minted.provenance_status, "verified");

  // EXPORT through the stage: ids and part paths on the run's row, never pool text.
  const out = mkdtempSync(join(tmpdir(), "caros-turn-"));
  const ex = await runTurn({ stage: "briefs", mode: "apply", input: { briefs: { export: { kind: "item-briefs", outDir: out } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(ex.exit, 0);
  const exRow = f.db.rows("harness_runs").find((r) => r.family === "brief-apply" && r.id === ex.rootRunId) as { outputs: { ids: Record<string, string[]> }; outcome: string };
  assert.deepEqual(exRow.outputs.ids.exported_ids, [minted.id]);
  assert.doesNotMatch(JSON.stringify(exRow.outputs), /Operators shall report/, "the ledger row carries ids and paths, not pool text");
  const part = JSON.parse(readFileSync(exRow.outputs.ids.parts?.[0] as string, "utf8")) as { items: { id: string; source_pool_hash: string; pool: { url: string; text: string }[]; required_slots: { slot_key: string }[] }[] };
  const stub = part.items[0] as (typeof part.items)[number];
  assert.deepEqual(stub.required_slots.map((s) => s.slot_key).sort(), ["binding_position", "due_date"]);
  assert.ok(stub.pool[0]?.text.includes(A2), "the author reads the capture the turn stored");

  // AUTHOR from the file, APPLY through the stage.
  const entry = withReview({
    item_id: stub.id, source_pool_hash: stub.source_pool_hash, body: regulatoryBody(), metadata: metadata({ format_type: "regulatory_fact_document", signal_band: null }),
    claims: [fact(A1, "8", "binding_position"), fact(A2, "8", "due_date"), fact(A3, "8"), fact(A4, "14")],
  });
  const file = JSON.stringify({ batch: "item-briefs-001", generated_at: NOW.toISOString(), authored_by: "session-lane", entries: [entry] });
  const dry = await runTurn({ stage: "briefs", mode: "dry", input: { briefs: { batch: { kind: "item-briefs", content: file } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(dry.exit, 0);
  assert.equal((f.db.rows("intelligence_items").find((r) => r.id === stub.id) as Record<string, unknown>).item_grade, "record", "a dry stage wrote nothing");
  const run = await runTurn({ stage: "briefs", mode: "apply", input: { briefs: { batch: { kind: "item-briefs", content: file } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(run.exit, 0);
  const row = f.db.rows("harness_runs").find((r) => r.family === "brief-apply" && r.id === run.rootRunId) as { outcome: string; outputs: { counts: Record<string, number>; ids: Record<string, string[]>; notes: string[] } };
  // The applied rows are written and the flywheel passes that follow ran: `success`.
  assert.equal(row.outcome, "success", JSON.stringify(row.outputs));
  assert.equal(row.outputs.counts.applied, 1);
  assert.deepEqual(row.outputs.ids.applied_ids, [stub.id]);
  const item = f.db.rows("intelligence_items").find((r) => r.id === stub.id) as Record<string, unknown>;
  assert.deepEqual([item.item_grade, item.provenance_status, item.format_type], ["brief", "verified", "regulatory_fact_document"]);
  const facts = f.db.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === stub.id && c.claim_kind === "FACT");
  const pool = f.db.rows("agent_run_searches").filter((r) => r.intelligence_item_id === stub.id);
  assert.ok(facts.length >= 4 && facts.every((c) => pool.some((p) => p.id === c.search_result_id) && String(pool[0]?.result_content).toLowerCase().includes(String(c.source_span).toLowerCase())), "every FACT is verbatim in the capture the turn stored");
  assert.ok(f.db.rows("claim_versions").length >= 1, "the stub's claims the ledger replaced were archived first");
  assert.equal(f.db.rows("intelligence_changes").filter((c) => c.item_id === stub.id).length, 1, "the customer-visible change is recorded once");

  // RE-APPLY: nothing new, the stage records a no-op (the cooldown does not apply: nothing is left to write).
  const writes = f.db.writes().length;
  const again = await runTurn({ stage: "briefs", mode: "apply", input: { briefs: { batch: { kind: "item-briefs", content: file } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(again.exit, 0);
  const rec = f.db.rows("harness_runs").find((r) => r.family === "brief-apply" && r.id === again.rootRunId) as { outcome: string };
  assert.equal(rec.outcome, "noop");
  const moved = f.db.writes().slice(writes);
  assert.ok(moved.every((w) => w.table === "harness_runs"), "only the ledger moved");
  assert.deepEqual(moved.map((w) => w.op), ["update", "insert", "update"], "the reaper's sweep (it matched nothing), then the run's own row: begun, then concluded");
});
