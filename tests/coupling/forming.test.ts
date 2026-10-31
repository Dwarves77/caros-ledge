// ENGINE-JOIN-1 addendum B: a pattern whose inputs are partly held is recorded as a forming derived value that says what is missing; it is superseded when the pattern appears and obsolete when its inputs vanish; a forming row is never admissible.
import assert from "node:assert/strict";
import { test } from "node:test";

import { connect, countsOf, patternFixture, propagate } from "./_world.ts";

type Row = Record<string, unknown>;
const forming = (f: ReturnType<typeof patternFixture>): Row[] => f.db.rows("derived_values").filter((r) => String(r.method_id).startsWith("forming_"));

test("B: removing the capacity a mandate met leaves the mandate forming, naming the Operations figure that is missing; restoring it supersedes the forming row; removing the mandate makes it obsolete", async () => {
  const f = patternFixture();
  await propagate(f);
  await connect(f);
  assert.equal(forming(f).filter((r) => r.lifecycle === "forming").length, 0, "every planted mandate meets its capacity: nothing is forming");
  const roadmaps = f.db.rows("oem_tech_roadmaps").splice(0);
  const refs = f.db.rows("entity_refs").filter((r) => r.ref_table === "oem_tech_roadmaps");
  f.db.rows("entity_refs").splice(0, f.db.rows("entity_refs").length, ...f.db.rows("entity_refs").filter((r) => r.ref_table !== "oem_tech_roadmaps"));
  assert.ok(roadmaps.length && refs.length);
  await connect(f);
  const open = forming(f).filter((r) => r.lifecycle === "forming");
  assert.ok(open.length >= 1, "a mandate with no capacity is forming");
  assert.ok(open.every((r) => String(r.method_id).startsWith("forming_") && !String(r.method_id).startsWith("pattern_") && r.value === null));
  const missing = open[0]?.missing as { surface: string; truth: string; entity: string };
  assert.deepEqual(Object.keys(missing).sort(), ["entity", "surface", "truth"]);
  assert.ok(["operations", "market", "research"].includes(missing.surface));
  assert.ok(!/scenario|compliance_object|shared_/.test(missing.truth));
  const counted = countsOf(f, "corpus-turn");
  assert.equal(counted.forming_new, open.length);
  await connect(f);
  assert.equal(countsOf(f, "corpus-turn").forming_unchanged, open.length, "a second turn changes nothing");
  assert.equal(forming(f).length, open.length);
  const mandates = f.db.rows("obligation_objects").splice(0);
  await connect(f);
  assert.equal(countsOf(f, "corpus-turn").forming_obsolete, open.length, "the mandate is gone: its forming row is obsolete");
  assert.equal(forming(f).filter((r) => r.lifecycle === "forming").length, 0);
  f.db.rows("obligation_objects").push(...mandates);
  await connect(f);
  assert.equal(forming(f).filter((r) => r.lifecycle === "forming").length, open.length, "the mandate is back: forming again");
  f.db.rows("oem_tech_roadmaps").push(...roadmaps);
  f.db.rows("entity_refs").push(...refs);
  await connect(f);
  assert.equal(forming(f).filter((r) => r.lifecycle === "forming").length, 0, "the pattern appeared: the forming rows are superseded");
  assert.ok((countsOf(f, "corpus-turn").forming_emerged ?? 0) >= 1);
});

test("B: a statutory ceiling with no technology and no abatement cost meeting it is forming on the Research side", async () => {
  const f = patternFixture();
  await propagate(f);
  f.db.rows("derived_values").splice(0, f.db.rows("derived_values").length, ...f.db.rows("derived_values").filter((r) => r.method_id !== "fixture_abatement"));
  f.db.rows("research_assessments").splice(0);
  await connect(f);
  const open = forming(f).filter((r) => r.lifecycle === "forming");
  assert.ok(open.some((r) => r.method_id === "forming_penalty_abatement" && (r.missing as { surface: string }).surface === "research"), JSON.stringify(open.map((r) => [r.method_id, r.missing])));
  assert.ok(open.every((r) => r.admissibility === "display_only" && r.value === null));
});
