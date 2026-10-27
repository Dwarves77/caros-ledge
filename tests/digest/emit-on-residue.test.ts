// EMIT-ON-RESIDUE (ENGINE-UNBLOCK-1): an item-brief entry whose PROSE is residue (a failing rule or judge) still writes the typed blocks that passed their own validation: obligation_fields, connections, events, document_date and entity_ids.
// The prose (body, metadata, sections, claims) waits. A block whose own judge failed is not written (J20: connections, J18: entity_ids); J19 does not block obligation_fields; a refused entry writes nothing; an accepted entry is unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";

import { READER_METHOD } from "@/core/digest/kinds";
import { review } from "@/core/digest/review";
import { applyBatch } from "@/features/batches";

import { batchFile, ITEM } from "../batches/world.ts";

import { emissionEntry, emissionWorld, type EmissionWorld } from "./emission-world.ts";

const apply = (w: EmissionWorld, e: Record<string, unknown>, dry = false) => applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", [e])), dry, runId: "r1" });
/** The entry with the named judges failed (a required judge that fails makes the prose residue). */
function failing(e: Record<string, unknown>, ...ids: string[]): Record<string, unknown> {
  const r = e.review as { reviewed_by: string; judges: Record<string, { pass: boolean; evidence: string }> };
  const judges = { ...r.judges };
  for (const id of ids) judges[id] = { pass: false, evidence: `${id}: the fixture fails it on purpose` };
  return { ...e, review: { ...r, judges } };
}
const OTHER = (e: Record<string, unknown>): string => review("item-briefs", e).required.find((id) => !["J18", "J19", "J20"].includes(id)) as string;
const counts = (w: EmissionWorld) => ({ refs: w.db.rows("entity_refs").filter((r) => r.ref_table === "intelligence_items").length, objects: w.db.rows("obligation_objects").filter((r) => r.method_version === READER_METHOD).length, relations: w.db.rows("entity_relations").length, events: w.db.rows("item_forward_events").length, terms: w.db.rows("vocabulary_terms").length });
const reviewRow = (w: EmissionWorld) => w.db.rows("brief_reviews").find((r) => r.subject_id === ITEM) as { residue: boolean; reasons: string };

test("a residue entry with a valid emission writes its blocks, not its prose, and its review row says which blocks", async () => {
  const w = emissionWorld();
  const base = emissionEntry(w);
  const e = failing(base, OTHER(base));
  const stored = String((w.db.rows("intelligence_items")[0] as { full_brief?: string }).full_brief ?? "");
  const r = await apply(w, e);
  assert.equal(r.counts.valid, 0);
  assert.equal(r.counts.residue, 1, r.notes.join("\n"));
  assert.equal(r.counts.residue_emitted, 1, r.notes.join("\n"));
  const c = counts(w);
  assert.ok(c.refs > 0 && c.objects === 2 && c.relations === 1 && c.events === 1, JSON.stringify(c));
  assert.equal(c.terms, 0, "a new-entity candidate is about the prose and waits with it");
  assert.equal(String((w.db.rows("intelligence_items")[0] as { full_brief?: string }).full_brief ?? ""), stored, "the prose is not written");
  assert.equal(w.db.rows("intelligence_item_sections").length, 0);
  assert.equal(w.db.rows("agent_run_searches").find((x) => x.id === w.cap)?.document_date, "2023-09-13");
  const row = reviewRow(w);
  assert.equal(row.residue, true);
  assert.match(row.reasons, /emission blocks written: entity_ids \d+, obligation_fields 2, connections 1, events 1, document_date 1; skipped: new_entity_candidates/);
});

test("a J20 failure skips the entry's connections and a J18 failure its entity_ids; a J19 failure does not block obligation_fields", async () => {
  const j20 = emissionWorld();
  await apply(j20, failing(emissionEntry(j20), "J20"));
  assert.equal(counts(j20).relations, 0, "J20 failed: no connection");
  assert.ok(counts(j20).objects === 2 && counts(j20).events === 1 && counts(j20).refs > 0);
  assert.match(reviewRow(j20).reasons, /skipped: connections \(J20 failed\)/);

  const j18 = emissionWorld();
  await apply(j18, failing(emissionEntry(j18), "J18"));
  assert.equal(counts(j18).refs, 0, "J18 failed: no entity_ids ref on the item");
  assert.ok(counts(j18).relations === 1 && counts(j18).objects === 2);
  assert.match(reviewRow(j18).reasons, /skipped: entity_ids \(J18 failed\)/);

  const j19 = emissionWorld();
  await apply(j19, failing(emissionEntry(j19), "J19"));
  assert.equal(counts(j19).objects, 2, "J19 does not block obligation_fields");
  assert.ok(counts(j19).relations === 1 && counts(j19).refs > 0);
});

test("a refused entry writes nothing: a quote the capture does not hold refuses the emission and the entry with it", async () => {
  const w = emissionWorld();
  const base = emissionEntry(w);
  const bad = failing({ ...base, connections: [{ ...(base.connections as Record<string, unknown>[])[0], quote: { capture_id: w.cap, text: "This sentence is not in any capture of the item." } }] }, OTHER(base));
  const r = await apply(w, bad);
  assert.equal(r.counts.refused, 1, r.notes.join("\n"));
  assert.equal(r.counts.residue_emitted ?? 0, 0);
  assert.deepEqual(counts(w), { refs: 0, objects: 0, relations: 0, events: 0, terms: 0 });
  assert.equal(w.db.rows("agent_run_searches").find((x) => x.id === w.cap)?.document_date ?? null, null);
});

test("a dry run writes nothing for a residue entry, and an accepted entry is unchanged (applied, prose and candidate written, no residue emission)", async () => {
  const w = emissionWorld();
  const base = emissionEntry(w);
  await apply(w, failing(base, OTHER(base)), true);
  assert.deepEqual(counts(w), { refs: 0, objects: 0, relations: 0, events: 0, terms: 0 });
  const ok = emissionWorld();
  const r = await apply(ok, emissionEntry(ok));
  assert.equal(r.counts.applied, 1, r.notes.join("\n"));
  assert.equal(r.counts.residue_emitted ?? 0, 0);
  const c = counts(ok);
  assert.ok(c.objects === 2 && c.relations === 1 && c.events === 1 && c.terms === 1, JSON.stringify(c));
});
