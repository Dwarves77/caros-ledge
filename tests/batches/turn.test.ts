// ONE system (operator, 2026-10-16): the briefs stage proven on the output of the fixture turn. The turn mints a regulation from a stored capture; the briefs stage EXPORTS it to a scratch directory, a session authors the
// full brief FROM THAT FILE (its pool text, its pool hash, its required slots), the stage applies it, and the item is a brief with the claims grounded in the capture the turn stored, the queue empty, and the run recorded
// under the turn's root. Nothing is seeded by hand: the item, its pool and its slots are what the machine wrote.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanGateA } from "@/core/grounding";
import { runTurn } from "@/core/turn";

import { fixture, NOW } from "../integration/world.ts";

import { metadata } from "./world.ts";

const A1 = "This Regulation applies to operators of cargo aircraft and to operators of container vessels calling at Union ports.";
const A2 = "Operators shall report verified annual emissions to the competent authority before 30 April of each year.";
const A3 = "A penalty of up to EUR 50 000 shall apply to an operator that fails to report within the period set out in Article 2.";
const A4 = "This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety.";

const HEADS = ["Purpose and Scope of This Document", "What This Regulation Is and Why It Applies to the Workspace", "Issues Requiring Immediate Action", "How the Workspace Sits in the Compliance Chain", "Authoritative Guidance Document Analysis", "Anticipated Authoritative Guidance and Pending Regulatory Events", "Threshold Questions", "Substantive Requirements", "Product-Specific Compliance Status", "Registration and Reporting Obligations", "Operational System Requirements", "Exemptions and Edge Cases", "Adjacent Industry Research and Alternatives", "Confirmed Regulatory Timeline", "Sources"];
const filler = "The reporting calendar belongs in this quarter's planning for every operator concerned, so the owner of the duty should be named early. ";
function regulatoryBody(): string {
  const req = [A1, A2, A3, "The applicability of the Regulation follows from Article 1, and the due date of the annual report from Article 2.", "*Operational implication:* each operating unit needs an owner for the annual report.", "No phase-in is stated in Articles 1 to 4.", "No exceptions are stated in Articles 1 to 4.", "Obligations surveyed: 3; workspace-adjacent: 3; extracted as FACT: 3."].join("\n\n");
  return HEADS.map((h, i) => `## ${i + 1}. ${h}\n\n${i === 7 ? req : i === 13 ? `- 1 January 2027: ${A4}` : i === 14 ? "- EUR-Lex: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999" : filler}`).join("\n\n");
}
const fact = (span: string, section: string, slot?: string) => ({ section, claim_kind: "FACT", claim_text: slot ? `[${slot}] ${span}` : span, source_span: span, source_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999", source_id: null, slot_key: slot ?? null });

/** The database trigger that recomputes an item's provenance when its brief changes (set_provenance_status_trg), reduced to the gate that matters here: a new brief whose figures the held FACT claims do not cover is quarantined until it is re-grounded. */
function installBriefTrigger(f: ReturnType<typeof fixture>): void {
  const prior = f.db.afterWrite;
  f.db.afterWrite = (c, d) => {
    prior?.(c, d);
    const body = c.table === "intelligence_items" && c.op === "update" ? (c.payload as { full_brief?: string } | undefined)?.full_brief : undefined;
    if (!body) return;
    for (const item of d.rows("intelligence_items").filter((r) => r.full_brief === body)) {
      const facts = d.rows("section_claim_provenance").filter((x) => x.intelligence_item_id === item.id && x.claim_kind === "FACT").map((x) => ({ claim_text: String(x.claim_text), source_span: String(x.source_span ?? "") }));
      if (scanGateA(body, facts).orphan_count > 0) item.provenance_status = "quarantined";
    }
  };
}

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
  const entry = {
    item_id: stub.id, source_pool_hash: stub.source_pool_hash, body: regulatoryBody(), metadata: metadata({ format_type: "regulatory_fact_document", signal_band: null }),
    claims: [fact(A1, "8", "binding_position"), fact(A2, "8", "due_date"), fact(A3, "8"), fact(A4, "14")],
  };
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
