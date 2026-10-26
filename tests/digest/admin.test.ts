// The admin kind (DIGEST-1 PR B): a finding is validated against its pattern's packet and written behind the platform-admin gate. INV-CN2-4 (an id outside the packet), INV-DIG-7 (a finding from one table or one surface is residue), the second reader's gate,
// the signposts registered as inference records, the supersession of an earlier finding, and the exporter's menu. INV-DIG-8's database half (a customer session reads nothing, cannot write) is migration 0122's self-check on the schema job.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PacketMember } from "@/core/digest/packets-client";
import { applyBatch, drainExporters } from "@/features/batches";
import type { BatchExport } from "@/features/batches";

import { batchFile } from "../batches/world.ts";

import { adminEntry, adminWorld, packet, PATTERN, ROWS } from "./admin-world.ts";

const apply = (w: ReturnType<typeof adminWorld>, entries: unknown[], dry = false) => applyBatch("admin-opportunity-findings", w.deps, { content: JSON.stringify(batchFile("admin-opportunity-findings", entries)), dry, runId: "a1" });
const notes = (r: { notes: string[] }) => r.notes.join("\n");

test("a finding from a cross-table, cross-surface packet applies: the finding, its registered signposts and its review, and a re-authored finding supersedes the first", async () => {
  const w = adminWorld();
  assert.equal((await apply(w, [adminEntry()], true)).counts.valid, 1);
  assert.equal(w.db.rows("admin_opportunity_findings").length, 0, "a dry run wrote nothing");
  const r = await apply(w, [adminEntry()]);
  assert.equal(r.counts.applied, 1, notes(r));
  const f = w.db.rows("admin_opportunity_findings")[0] as Record<string, unknown>;
  assert.deepEqual([f.lens, f.window, f.pattern_value_id, (f.signpost_inference_ids as string[]).length, f.superseded_by ?? null], ["supply_demand_bottleneck", "6-18m", PATTERN, 1, null]);
  assert.equal(w.db.rows("inference_records").length, 1);
  assert.equal(w.db.rows("brief_reviews").filter((b) => b.kind === "admin-opportunity-findings").length, 1);
  assert.equal((await apply(w, [adminEntry()])).counts.already_applied, 1, "the same finding again writes nothing");
  assert.equal(w.db.rows("admin_opportunity_findings").length, 1);
  const again = await apply(w, [adminEntry({ title: "A 50 MW charging mandate meets a 31-month queue, restated" })]);
  assert.equal(again.counts.applied, 1, notes(again));
  const all = w.db.rows("admin_opportunity_findings");
  assert.equal(all.length, 2);
  assert.equal(all.filter((x) => !x.superseded_by).length, 1, "one current finding per pattern");
});

test("INV-CN2-4: a row outside the packet, a span the row does not offer, a missing signpost and a pattern with no packet are refused", async () => {
  const w = adminWorld();
  const out = `obligation_objects:cl:obligation:ffffffffffffffff`;
  assert.match(notes(await apply(w, [adminEntry({ sourced_finding_md: `The mandate [${out}] and the queue [${ROWS.grid}].` })])), new RegExp(`cites ${out}, which is not a row of the packet`));
  assert.match(notes(await apply(w, [adminEntry({ claim_provenance: [{ row: ROWS.grid, span: "median grid connection queue is 29 months" }] })])), /span is not verbatim in the packet row/);
  assert.match(notes(await apply(w, [adminEntry({ claim_provenance: [{ row: out, span: "x" }] })])), /is not a row of the packet/);
  assert.match(notes(await apply(w, [adminEntry({ signposts: [] })])), /at least one falsifiable signpost/);
  assert.match(notes(await apply(adminWorld([]), [adminEntry()])), /no packet for this pattern/);
  assert.equal(w.db.rows("admin_opportunity_findings").length, 0);
});

test("INV-DIG-7: a finding that cites rows from a single table, or from a single surface, is residue with the reason, and nothing is written", async () => {
  const w = adminWorld();
  const oneTable = adminEntry({ sourced_finding_md: `The queue is long [${ROWS.grid}].`, inferences: [], claim_provenance: [] });
  const t = await apply(w, [oneTable]);
  assert.match(notes(t), /every cited row is from .* table, at least two tables are required|every cited row is from obligation_objects|grid_connection_queues table/);
  const sameSurface = adminEntry({ sourced_finding_md: `The queue is long [${ROWS.grid}] and the unit is late [${ROWS.oem}].`, inferences: [], claim_provenance: [] });
  const w2 = adminWorld([{ ...packet(), members: (packet().members as PacketMember[]).filter((m) => m.table === "grid_connection_queues" || m.table === "oem_tech_roadmaps").map((m) => ({ ...m, surface: "operations" })) }]);
  const s = await apply(w2, [sameSurface]);
  assert.match(notes(s), /every cited row is on operations surface, at least two surfaces are required/);
  assert.equal(w.db.rows("admin_opportunity_findings").length + w2.db.rows("admin_opportunity_findings").length, 0);
});

test("the second reader gates the finding: a missing verdict set, a failed judge and a verdict with no evidence each keep it out and name the criterion", async () => {
  const w = adminWorld();
  const noReview = { ...adminEntry() } as Record<string, unknown>;
  delete noReview.review;
  assert.match(notes(await apply(w, [noReview])), /second reader.*verdicts are missing/);
  const ok = adminEntry();
  const judges = (ok.review as { judges: Record<string, { pass: boolean; evidence: string }> }).judges;
  const failing = (id: string, v: { pass: boolean; evidence: string }) => ({ ...ok, review: { ...(ok.review as object), judges: { ...judges, [id]: v } } });
  assert.match(notes(await apply(w, [failing("J23", { pass: false, evidence: "the grid row alone states the direction" })])), /J23 cross-surface-direction: failed/);
  assert.match(notes(await apply(w, [failing("J05", { pass: true, evidence: "" })])), /J05 cause-effect-sourced: a verdict without its evidence/);
  assert.equal(w.db.rows("admin_opportunity_findings").length, 0);
});

test("the admin export carries the candidate_entities menu seeded from the packet's member rows", async () => {
  const w = adminWorld();
  const out = (await drainExporters(w.deps)["admin-opportunity-findings"]!({ limit: 5, mode: "pending" })) as BatchExport;
  assert.equal(out.ok, true, out.error);
  const item = out.items[0] as { candidate_entities: { entities: string[]; truncated: number }; packets: unknown[] };
  assert.equal(item.packets.length, 1);
  assert.deepEqual(Object.keys(item.candidate_entities), ["entities", "truncated"]);
});
