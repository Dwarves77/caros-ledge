// FIX-P1-1: the recorder reads a run's writes from the family's declared `writes` (core/harness/data/families.json, applied by classify). A stage that reports a write under a key its family does not declare records `noop` over rows it wrote.
// Found on production: the patterns-apply run wrote 19 pattern values and 843 evidence edges and was recorded noop (run 64a761a9). Each case below is the counts of a real run, or a runtime's own result over the fixture, and must classify as the work it did.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, FAMILIES } from "@/core/harness";
import { runPatterns } from "@/core/flywheel/patterns";
import { runResult } from "@/core/types/run-result";

import { NOW, patternFixture, propagate } from "./_world.ts";

const writesOf = (family: string): readonly string[] => FAMILIES.find((f) => f.name === family)?.writes ?? [];
const outcomeOf = (family: string, counts: Record<string, number>): string => classify(runResult("ok", counts, []), writesOf(family), "apply").outcome;

test("a connect run that wrote one pattern value records success: the pattern step's own counts, over the planted fixture", async () => {
  const f = patternFixture();
  await propagate(f);
  const r = await runPatterns({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.ok((r.counts.patterns_new ?? 0) > 0, "the fixture yields a pattern");
  assert.equal(outcomeOf("corpus-turn", r.counts), "success");
});

test("the pattern counts that are reads or no-ops do not make a run a write: found-and-unchanged patterns stay noop", () => {
  assert.equal(outcomeOf("corpus-turn", { patterns: 19, patterns_unchanged: 19, patterns_velocity: 19, refs_read: 14305, relations_read: 48, facts_section_claim_provenance: 6391 }), "noop");
});

test("production run 64a761a9 (patterns-apply): 19 new patterns and nothing else is success", () => {
  const counts = { slice: 0, failed: 0, themes: 0, backlog: 1294, derived: 0, refused: 0, scanned: 0, patterns: 19, connected: 0, extracted: 0, refs_read: 14305, term_writes: 0, edges_written: 0, patterns_new: 19, patterns_superseded: 0, patterns_obsolete: 0, patterns_unchanged: 0, tag_items_written: 0 };
  assert.equal(outcomeOf("corpus-turn", counts), "success");
});

test("a stage that only superseded or retired patterns, synced a deadline, or resolved a trigger wrote", () => {
  for (const key of ["patterns_superseded", "patterns_obsolete", "deadlines_synced", "triggers_resolved"]) assert.equal(outcomeOf("corpus-turn", { [key]: 1 }), "success", key);
});

test("propagate: a coupling run that seeded and mined and drained nothing is success (run a09ec94a counts), and so is a seed-page capture alone", () => {
  assert.equal(outcomeOf("propagation", { drained: 0, seed_entities_written: 37, seed_aliases_written: 147, seed_relations_written: 48, refs_written: 14305 }), "success");
  for (const key of ["seed_entities_written", "seed_aliases_written", "seed_relations_written", "refs_written", "seed_capture_captured", "producers_capture_captured"]) assert.equal(outcomeOf("propagation", { [key]: 1 }), "success", key);
});

test("brief-apply: the retokenise pass rewrote items and lines and is success, not the noop 16 production rows recorded", () => {
  for (const key of ["items_rewritten", "lines_rewritten"]) assert.equal(outcomeOf("brief-apply", { applied: 0, [key]: 1 }), "success", key);
  assert.equal(outcomeOf("brief-apply", { applied: 0, items_scanned: 6, remaining: 6, items_failed: 0 }), "noop");
});

test("producers: rows a producer wrote under its own key (assessments, entities, refs, signposts, edges) are writes", () => {
  for (const key of ["written", "entities_written", "refs_written", "signposts_written", "edges_authored"]) assert.equal(outcomeOf("producers", { created: 0, updated: 0, [key]: 1 }), "success", key);
  assert.equal(outcomeOf("producers", { created: 0, updated: 0, unchanged: 10, parsed: 10 }), "noop");
});
