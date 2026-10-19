import assert from "node:assert/strict";
import { test } from "node:test";

import adversarial from "@/core/golden/data/rows-adversarial.json";
import ecotransit from "@/core/golden/data/rows-ecotransit.json";
import euMaritime from "@/core/golden/data/rows-eu-maritime.json";
import ghgProtocol from "@/core/golden/data/rows-ghg-protocol.json";
import glec from "@/core/golden/data/rows-glec.json";
import otherRegimes from "@/core/golden/data/rows-other-regimes.json";
import recheck from "@/core/golden/data/rows-recheck.json";
import { DOCUMENTS, parseRows } from "@/core/golden/load";

import { getDoc } from "./_docs.ts";
import { relationProblems } from "./_relations.ts";
import { proseOverlap, structureProblems } from "./_structure.ts";

// Each mutation is a deliberately broken copy of the real rows; the guard that owns the invariant must turn red on it, and the real rows must stay green.
type Raw = Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fresh = (): Raw => structuredClone([ghgProtocol, glec, ecotransit, euMaritime, otherRegimes, adversarial, recheck].flat()) as Raw;
const find = (rows: Raw, id: string): Record<string, any> => rows.find((r) => r.id === id)!; // eslint-disable-line @typescript-eslint/no-explicit-any
const out = (row: Record<string, any>, name: string): Record<string, any> => row.outputs.find((o: { name: string }) => o.name === name); // eslint-disable-line @typescript-eslint/no-explicit-any

test("the unmutated copy is green (the baseline every mutant is measured against)", () => {
  const rows = parseRows(fresh());
  assert.deepEqual(rows.flatMap(relationProblems), []);
  assert.deepEqual(structureProblems(rows), []);
});

test("mutant 1a, flip one expected digit in the value only: the loader refuses a value that is not its printed literal", () => {
  const rows = fresh();
  out(find(rows, "T9"), "i_wtw").value = "1.582";
  assert.throws(() => parseRows(rows), /T9: i_wtw: value 1\.582 is not the literal 1\.572/);
});

test("mutant 1b, flip one digit in value and literal together: the literal is on no cited locator", () => {
  const rows = fresh();
  const o = out(find(rows, "T9"), "i_wtw");
  o.value = "1.582";
  o.literal = "1.582";
  assert.throws(() => parseRows(rows), /T9: i_wtw: the printed literal 1\.582 is on no cited locator/);
});

test("mutant 1c, flip a digit in the value, the literal and the probe: the page no longer carries it and the arithmetic breaks", async () => {
  const rows = fresh();
  const t9 = find(rows, "T9");
  const o = out(t9, "i_wtw");
  o.value = "1.582";
  o.literal = "1.582";
  t9.checks[1].tokens = t9.checks[1].tokens.map((t: string) => (t === "1.572 kg" ? "1.582 kg" : t));
  const parsed = parseRows(rows);
  assert.ok(relationProblems(parsed.find((r) => r.id === "T9")!).length > 0, "the stated arithmetic must catch it offline");
  const d = DOCUMENTS.glec_v3_0!;
  const doc = await getDoc(d.url, d.format);
  if (doc.ok) assert.ok(!doc.pages[115]!.includes("1.582 kg"), "the cited page does not print the flipped digit");
});

test("mutant 2, paste one sentence of GLEC prose into a row: the structure test reports it (INV-R6a-2)", async (t) => {
  const d = DOCUMENTS.glec_v3_0!;
  const doc = await getDoc(d.url, d.format);
  if (!doc.ok) return void t.skip(`locator_stale: ${doc.reason}`);
  const words = doc.pages[103]!.split(" ").filter((w) => /^[A-Za-z]+$/.test(w));
  const sentence = words.slice(10, 24).join(" ");
  const rows = parseRows(fresh());
  assert.deepEqual(proseOverlap(rows, doc.pages.join(" ")), [], "the real rows share no prose");
  const mutated = structuredClone(rows);
  mutated[0]!.traps[0]!.what = sentence;
  assert.deepEqual(proseOverlap(mutated, doc.pages.join(" ")), ["T1.traps[0].what"]);
});

test("mutant 2b, quote a sentence: a quotation mark in any row fails the structure test", () => {
  const rows = parseRows(fresh());
  rows[0]!.traps[0]!.what = 'He wrote "a sentence" here';
  assert.match(structureProblems(rows).join("\n"), /T1.*quotation mark/);
});

test("mutant 2c, a phrase probe against a licence-red document: refused as not a bare figure", () => {
  const rows = parseRows(fresh());
  rows.find((r) => r.id === "T6")!.checks[0]!.tokens.push("the best workaround is");
  assert.match(structureProblems(rows).join("\n"), /T6: probe "the best workaround is".*not a bare figure/);
});

test("mutant 3, drop the GWP set from one row: the schema refuses it (INV-R6a-4 input)", () => {
  const rows = fresh();
  delete out(find(rows, "T1"), "total").gwp_set;
  assert.throws(() => parseRows(rows), /gwp_set/);
});

test("mutant 3b, a CO2e figure that claims its GWP set does not apply is refused", () => {
  const rows = fresh();
  Object.assign(out(find(rows, "T16"), "gwp_set_statement"), { unit: "t CO2e", gwp_set: "not_applicable" });
  assert.throws(() => parseRows(rows), /T16: gwp_set_statement: a CO2e figure names its GWP set/);
});

test("mutant 4, WTT + TTW no longer equals WTW: the arithmetic check fails unless the row carries source_unit_defect (INV-R6a-3)", () => {
  const rows = fresh();
  const t9 = find(rows, "T9");
  const set = (name: string, v: string) => { const q = [...t9.inputs, ...t9.outputs].find((x: { name: string }) => x.name === name)!; q.value = v; q.literal = v; };
  set("f_wtw", "4.12");
  t9.checks[1].tokens.push("4.12");
  const parsed = parseRows(rows).find((r) => r.id === "T9")!;
  assert.match(relationProblems(parsed).join("\n"), /T9 wtw: 0\.84 \+ 3\.18 is not 4\.12 within the last digit/);
  parsed.flags.push("source_unit_defect");
  assert.ok(!relationProblems(parsed).some((p) => /wtw/.test(p)), "a declared source defect lets the triple differ");
});

test("mutant 5, a guessed value: a verified row with a value and no printed literal cannot load (INV-R6a-1)", () => {
  const rows = fresh();
  const o = out(find(rows, "T6"), "activity");
  delete o.literal;
  assert.throws(() => parseRows(rows), /T6: activity: a printed value carries literal, locale and sigDigits/);
});

test("mutant 5b, a verified row with no locator cannot load; an unresolved row with a value cannot load", () => {
  const rows = fresh();
  find(rows, "T6").checks = [];
  assert.throws(() => parseRows(rows), /T6: a verified row cites a locator/);
  const rows2 = fresh();
  find(rows2, "G1").outputs.push({ name: "x", unit: "kg", origin: "printed", literal: "1", locale: "dp", value: "1", sigDigits: 1, boundary: "WTW", gwp_set: "not_stated" });
  assert.throws(() => parseRows(rows2), /G1: an unresolved row states its reason and carries no expected value/);
});

test("mutant 6, zero-fill a typed missing: a value beside a missing token cannot load", () => {
  const rows = fresh();
  out(find(rows, "T13"), "methanol_ch4").value = "0";
  assert.throws(() => parseRows(rows), /methanol_ch4 carries exactly one of value, text, missing/);
});

test("mutant 7, swap the locale of the MRV decimal-comma factor: the value no longer follows its literal", () => {
  const rows = fresh();
  out(find(rows, "L1"), "hfo_co2").locale = "dp";
  assert.throws(() => parseRows(rows), /L1: hfo_co2: value 3\.114 is not the literal 3,114 under dp/);
});

test("mutant 8, a derived value with no relation behind it: refused", () => {
  const rows = fresh();
  find(rows, "T5").relations = find(rows, "T5").relations.filter((r: { result: string }) => r.result !== "consignment_exact");
  assert.throws(() => parseRows(rows), /T5: consignment_exact: a derived value is the result of a stated relation/);
});
