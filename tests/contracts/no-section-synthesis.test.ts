// ADR-050 / FLY-1 wiring. No code path writes section or theme text that a batch entry does not state: the two synthesis modules do not exist and nothing imports them, a section row no batch entry states fails the briefs stage's
// read-back, and a planted committed batch on the fixture turn applies with its whole downstream (sections, provenance rows, scores, a cited source discovered, a pending trigger resolved by a later capture). A batch with one span
// that is not verbatim in its capture is held whole with its reasons; applying the same batch twice writes nothing the second time.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runTurn } from "@/core/turn";
import { correctionsFile } from "@/core/digest/corrections";
import { committedNames } from "@/features/batches";
import { nextBatchPath, resolveKind } from "@/features/drain";
import { resolvePendingTriggers } from "@/features/obligations";

import { A1, A2, A3, A4, fact, installBriefTrigger, regulatoryBody } from "../batches/regulatory.ts";
import { metadata } from "../batches/world.ts";
import { fixture, NOW } from "../integration/world.ts";
import { MemDb, type Row } from "../_support/memdb.ts";

const EVENT = "e0000000-0000-4000-8000-000000000001";
const LATER = "a0000000-0000-4000-8000-000000000002";
const EARLIER = "a0000000-0000-4000-8000-000000000001";
const ACT = "Commission Implementing Regulation (EU) 2027/55";
const IEA = "https://www.iea.org/reports/global-energy-review";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

/** The fixture turn through the mint: one regulation record, verified, with the capture the turn stored. */
async function minted() {
  const f = fixture();
  installBriefTrigger(f);
  assert.equal((await runTurn({ stage: "all", mode: "apply", input: { intake: { census: { limit: 5 } } } }, { d: f.d, env: {}, now: () => NOW })).exit, 0);
  const item = f.db.rows("intelligence_items").find((r) => r.item_grade === "record") as Row;
  return { f, item };
}
/** A pending implementing-act trigger written on 1 October and a capture of the item taken after it that states the act. */
function plant(f: Awaited<ReturnType<typeof minted>>["f"], itemId: unknown): void {
  f.db.rows("item_forward_events").push({ id: EVENT, intelligence_item_id: itemId, event_date: "2027-01-01", date_precision: "year", event_kind: "implementing_act_due", obligation_text: "The Commission shall adopt implementing acts by 2027.", source_kind: "section", source_span: "2027", confidence: "medium", extractor_version: "fly-1-test", created_at: "2026-10-01T00:00:00.000Z", resolved_at: null, resolved_capture_id: null, resolved_span: null });
  f.db.rows("agent_run_searches").push({ id: LATER, agent_run_id: null, intelligence_item_id: itemId, result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32027R0055", result_title: null, result_index: 1, result_content: `${ACT} laying down detailed rules for the annual report was adopted and published. ${"Notice. This text is provided for information. ".repeat(30)}`, searched_at: "2026-10-14T00:00:00.000Z", result_chars: 1500 });
}
/** Export the stub through the stage, author a batch from it, and commit it as item-briefs-001 under a fresh root. */
async function commit(f: Awaited<ReturnType<typeof minted>>["f"], over: { a2?: string; newSources?: string } = {}): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "caros-fly1-out-"));
  const ex = await runTurn({ stage: "briefs", mode: "apply", input: { briefs: { export: { kind: "item-briefs", outDir: out } } } }, { d: f.d, env: {}, now: () => NOW });
  const row = f.db.rows("harness_runs").find((r) => r.id === ex.rootRunId) as { outputs: { ids: Record<string, string[]> } };
  const stub = (JSON.parse(readFileSync(row.outputs.ids.parts?.[0] as string, "utf8")) as { items: { id: string; source_pool_hash: string }[] }).items[0] as { id: string; source_pool_hash: string };
  const a2 = over.a2 ?? A2;
  const entry = { item_id: stub.id, source_pool_hash: stub.source_pool_hash, body: regulatoryBody(over.newSources), metadata: metadata({ format_type: "regulatory_fact_document", signal_band: null, sources_used: [] }), claims: [fact(A1, "8", "binding_position"), fact(a2, "8", "due_date"), fact(A3, "8"), fact(A4, "14")] };
  const root = mkdtempSync(join(tmpdir(), "caros-fly1-"));
  mkdirSync(join(root, "drain/batches/item-briefs"), { recursive: true });
  writeFileSync(join(root, "drain/batches/item-briefs/item-briefs-001.json"), JSON.stringify({ batch: "item-briefs-001", generated_at: NOW.toISOString(), authored_by: "session-lane", entries: [entry] }));
  return root;
}
const briefs = async (f: Awaited<ReturnType<typeof minted>>["f"], root: string) => {
  const run = await runTurn({ stage: "briefs", mode: "apply", input: { briefs: { batchRoot: root } } }, { d: f.d, env: {}, now: () => NOW });
  const row = f.db.rows("harness_runs").find((r) => r.family === "brief-apply" && r.id === run.rootRunId) as { outcome: string; outputs: { counts: Record<string, number>; ids: Record<string, string[]>; notes: string[] } };
  return { run, row, c: row.outputs.counts };
};

test("INV-FLY-1: the two synthesis modules do not exist and nothing imports them", () => {
  assert.equal(existsSync("src/features/flywheel/section-synthesis.ts") || existsSync("src/features/flywheel/theme-synthesis.ts"), false);
  const importers = [...walk("src"), ...walk("tests"), ...walk("scripts")].filter((p) => /\.(ts|tsx|mjs)$/.test(p) && !p.endsWith("no-section-synthesis.test.ts") && /(section|theme)-synthesis/.test(readFileSync(p, "utf8")));
  assert.deepEqual(importers, []);
});

test("INV-FLY-3 and INV-FLY-4: a committed batch applies on the fixture turn with its whole downstream, and a second turn writes nothing", async () => {
  const { f, item } = await minted();
  plant(f, item.id);
  const root = await commit(f, { newSources: `| IEA | ${IEA} |` });
  const sourcesBefore = f.db.rows("sources").length;
  const before = f.db.writes().length;
  const { run, row, c } = await briefs(f, root);
  assert.equal(run.exit, 0);
  assert.equal(row.outcome, "success", JSON.stringify(row.outputs));
  assert.deepEqual([c.batches_found, c.batches_applied, c.batches_held, c.applied], [1, 1, 0, 1]);
  // sections come from the batch entry; the provenance rows are the grounded claims.
  const sections = f.db.rows("intelligence_item_sections").filter((s) => s.item_id === item.id);
  assert.equal(sections.length, 15);
  assert.ok(f.db.rows("section_claim_provenance").filter((p) => p.intelligence_item_id === item.id && p.claim_kind === "FACT").length >= 4);
  assert.deepEqual([(f.db.rows("intelligence_items").find((r) => r.id === item.id) as Row).item_grade, (f.db.rows("intelligence_items").find((r) => r.id === item.id) as Row).provenance_status], ["brief", "verified"]);
  // the downstream: scores recomputed over the applied item, a cited source discovered, the pending trigger resolved with the capture and the statement.
  assert.equal(c.impact_scored, 1);
  assert.deepEqual(row.outputs.ids.scored_item_ids, [item.id]);
  assert.ok(f.db.writes().slice(before).some((w) => w.table === "item_impact_scores"));
  assert.ok(c.grow_registered === 1 && f.db.rows("sources").length > sourcesBefore && f.db.rows("sources").some((s) => String(s.url).startsWith(IEA)), `a cited source was discovered: ${JSON.stringify(c)}`);
  assert.deepEqual([c.triggers_pending, c.triggers_resolved], [1, 1]);
  const ev = f.db.rows("item_forward_events").find((e) => e.id === EVENT) as Row;
  assert.deepEqual([ev.resolved_capture_id, ev.resolved_span, ev.resolved_at], [LATER, ACT, NOW.toISOString()]);
  assert.deepEqual(row.outputs.ids.resolved_event_ids, [EVENT]);
  const ledger = f.db.rows("applied_batches");
  assert.deepEqual(ledger.map((l) => [l.batch_id, l.kind, l.status]), [["item-briefs-001", "item-briefs", "applied"]]);

  // INV-FLY-4: the same batch on the next turn is read, found in the ledger, and nothing is written but the turn's own ledger row.
  const writes = f.db.writes().length;
  const again = await briefs(f, root);
  assert.deepEqual([again.c.batches_found, again.c.batches_skipped, again.c.applied ?? 0], [1, 1, 0]);
  assert.ok(f.db.writes().slice(writes).every((w) => w.table === "harness_runs"), "only the run ledger moved");
});

test("INV-FLY-2: a batch with one span altered so it is not verbatim in its capture is held whole, with reasons in the ledger row and the corrections file", async () => {
  const { f, item } = await minted();
  const root = await commit(f, { a2: A2.replace("30 April", "31 April") });
  const sectionsBefore = JSON.stringify(f.db.rows("intelligence_item_sections"));
  const before = f.db.writes().length;
  const { row, c } = await briefs(f, root);
  assert.deepEqual([c.batches_held, c.batches_applied, c.applied ?? 0], [1, 0, 0]);
  assert.equal((f.db.rows("intelligence_items").find((r) => r.id === item.id) as Row).item_grade, "record", "the item still holds its record: nothing of the brief was written");
  assert.equal(JSON.stringify(f.db.rows("intelligence_item_sections")), sectionsBefore, "no section was written");
  assert.ok(f.db.writes().slice(before).every((w) => ["harness_runs", "applied_batches"].includes(w.table)), "the held batch wrote only its ledger row");
  const ledger = f.db.rows("applied_batches")[0] as Row;
  assert.deepEqual([ledger.batch_id, ledger.status], ["item-briefs-001", "held"]);
  assert.match(JSON.stringify(ledger.reasons), /not a verbatim substring of the item's pool text/);
  const corrections = JSON.parse(readFileSync(join(root, "drain/batches/item-briefs/item-briefs-001.corrections.json"), "utf8")) as { batch: string; refused: { key: string; errors: string[] }[] };
  assert.equal(corrections.batch, "item-briefs-001");
  assert.doesNotThrow(() => correctionsFile.parse(corrections), "the corrections file has the shape DIGEST-1 reads");
  // the next drain plan numbers after the committed batch (the corrections file takes no number) and finds the corrections beside it.
  const names = committedNames(root, "drain/batches/item-briefs");
  assert.deepEqual(names.sort(), ["item-briefs-001.corrections.json", "item-briefs-001.json"]);
  assert.equal(nextBatchPath(resolveKind("item-briefs") as NonNullable<ReturnType<typeof resolveKind>>, names), "drain/batches/item-briefs/item-briefs-002.json");
  assert.match(corrections.refused[0]?.errors.join(" ") ?? "", /not a verbatim substring/);
  assert.equal(row.outputs.ids.scored_item_ids, undefined, "no downstream ran over a held brief");
});

test("INV-FLY-1: a section row that no batch entry states fails the briefs stage, the batch is held and the downstream does not run over it", async () => {
  const { f, item } = await minted();
  plant(f, item.id);
  const root = await commit(f);
  // The planted code path: after the reconcile, something else writes a section whose text is in no batch entry.
  const reconcile = f.db.rpcs.ledger_reconcile_sections as NonNullable<typeof f.db.rpcs.ledger_reconcile_sections>;
  f.db.rpcs.ledger_reconcile_sections = (a, d) => {
    const out = reconcile(a, d);
    d.rows("intelligence_item_sections").push({ id: d.nextId(), item_id: a.p_item_id, section_key: "synth", section_order: 99, content_md: "Immediate action is required of every operator before the end of the quarter.", is_conditional: false });
    return out;
  };
  const before = f.db.writes().length;
  const { row, c } = await briefs(f, root);
  assert.equal(c.read_back_failures, 1);
  assert.deepEqual(row.outputs.ids.read_back_failed_ids, [item.id]);
  assert.deepEqual([c.batches_held, c.batches_applied], [1, 0]);
  assert.equal((f.db.rows("applied_batches")[0] as Row).status, "held");
  assert.ok(f.db.writes().slice(before).every((w) => w.table !== "item_impact_scores"), "no score was written over the refused item");
  assert.equal((f.db.rows("item_forward_events").find((e) => e.id === EVENT) as Row).resolved_at, null, "no trigger was resolved over the refused item");
});

test("pending triggers: the connect stage resolves the backlog from a later capture with no batch; a citation the item already held, or a capture taken before the event, resolves nothing", async () => {
  const { f, item } = await minted();
  plant(f, item.id);
  const c = await runTurn({ stage: "connect", chain: false, mode: "apply" }, { d: f.d, env: {}, now: () => NOW });
  const row = f.db.rows("harness_runs").find((r) => r.family === "corpus-turn" && r.id === c.rootRunId) as { outputs: { counts: Record<string, number> } };
  assert.deepEqual([row.outputs.counts.triggers_pending, row.outputs.counts.triggers_resolved], [1, 1]);
  assert.equal((f.db.rows("item_forward_events").find((e) => e.id === EVENT) as Row).resolved_span, ACT);

  const db = new MemDb({}, {});
  const event = { id: EVENT, intelligence_item_id: "i1", event_kind: "implementing_act_due", created_at: "2026-10-01T00:00:00.000Z", source_capture_id: null, resolved_at: null };
  const cap = (id: string, at: string, text: string) => ({ id, intelligence_item_id: "i1", result_content: text, searched_at: at });
  db.seed("item_forward_events", [event]);
  db.seed("agent_run_searches", [cap(EARLIER, "2026-09-01T00:00:00.000Z", `Recital 4 recalls ${ACT} on an earlier matter.`), cap(LATER, "2026-10-14T00:00:00.000Z", `${ACT} was in the consolidated text again.`)]);
  const r = await resolvePendingTriggers({ sb: db.client, now: () => NOW }, { dry: false });
  assert.deepEqual([r.counts.resolved, r.counts.still_pending], [0, 1]);
  db.seed("agent_run_searches", [cap(EARLIER, "2026-10-14T00:00:00.000Z", `${ACT} was adopted.`)]);
  assert.equal((await resolvePendingTriggers({ sb: db.client, now: () => NOW }, { dry: false })).counts.resolved, 0, "a capture taken before the event is not a later capture");
});

test("dry: a committed batch is validated and planned the same and nothing is written", async () => {
  const { f, item } = await minted();
  plant(f, item.id);
  const root = await commit(f);
  const before = f.db.writes().length;
  const run = await runTurn({ stage: "briefs", mode: "dry", input: { briefs: { batchRoot: root } } }, { d: f.d, env: {}, now: () => NOW });
  const c = (f.db.rows("harness_runs").find((r) => r.family === "brief-apply" && r.id === run.rootRunId) as { outputs: { planned: Record<string, number> } }).outputs.planned;
  assert.deepEqual([c.batches_found, c.batches_applied, c.valid, c.applied], [1, 1, 1, 0]);
  assert.ok(f.db.writes().slice(before).every((w) => w.table === "harness_runs"), "only the run ledger moved");
  assert.deepEqual(f.db.rows("applied_batches"), []);
  assert.equal(existsSync(join(root, "drain/batches/item-briefs/item-briefs-001.corrections.json")), false);
});

test("0126: a ledger that cannot be read applies nothing and says so; a resolution write that fails is counted, not hidden", async () => {
  const { f, item } = await minted();
  plant(f, item.id);
  const root = await commit(f);
  f.db.fail("applied_batches", "select", "relation applied_batches does not exist");
  const before = f.db.writes().length;
  const { row, c } = await briefs(f, root);
  assert.equal(row.outcome, "refused");
  assert.match(row.outputs.notes.join(" "), /applied-batches ledger read failed, nothing was applied/);
  assert.equal(c.applied ?? 0, 0);
  assert.equal((f.db.rows("intelligence_items").find((r) => r.id === item.id) as Row).item_grade, "record");
  assert.ok(f.db.writes().slice(before).every((w) => w.table === "harness_runs"));

  f.db.fail("item_forward_events", "update", "column resolved_at does not exist");
  const r = await resolvePendingTriggers({ sb: f.db.client, now: () => NOW }, { dry: false, itemIds: [String(item.id)] });
  assert.deepEqual([r.outcome, r.counts.resolved, r.counts.write_failures], ["partial", 0, 1]);
  assert.equal((f.db.rows("item_forward_events").find((e) => e.id === EVENT) as Row).resolved_at, null);
});
