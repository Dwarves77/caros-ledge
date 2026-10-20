// INV-R2a-4: the old gate-a-scan accepted EUR 5 for EUR 50 (probe output in the PR body); the new one refuses it. The tokenizer probe from the methods
// register: every EU-legal-format figure and every compound intensity is read whole, none is dropped or truncated. S-NUMERIC is a hard hold.
import assert from "node:assert/strict";
import { test } from "node:test";

import { scanGateA } from "@/core/grounding/gate-a-scan";
import { mintGates } from "@/core/grounding/gates";
import { decideSlotClaim, nominateForSlot, uncoveredSlots } from "@/core/grounding/slots";

const fact = (claim_text: string, source_span = claim_text, locale?: string) => ({ claim_text, source_span, ...(locale ? { locale } : {}) });

test("the tokenizer probe: standards-style prose is read whole (the old tokenizer dropped or truncated all six)", () => {
  const figures = (t: string, locale?: string) => scanGateA(t, [], new Set(), locale ? { locale } : {}).orphans.filter((o) => o.class === "figure").map((o) => o.token);
  assert.deepEqual(figures("0,863 t CO2/t clinker"), ["0,863 t CO2/t clinker"], "was []");
  assert.deepEqual(figures("49.9 g CO2e/TEU-km"), ["49.9 g CO2e/TEU-km"], "was []");
  assert.deepEqual(figures("144 900 t clinker"), ["144 900 t"], "was []");
  assert.deepEqual(figures("EUR 2 400 per tonne"), ["EUR 2 400"], "was [EUR 2]");
  assert.deepEqual(figures("96.6 gCO2e/MJ"), ["96.6 gCO2e/MJ"], "was [96.6 gCO2]");
  assert.deepEqual(figures("1.572 kg CO2e/tkm"), ["1.572 kg CO2e/tkm"], "was [1.572 kg]");
});

test("INV-R2a-4: EUR 5 in the brief is NOT backed by a FACT that says EUR 50 (the old scan reported orphan_count 0)", () => {
  assert.equal(scanGateA("The fee is €5 per tonne.", [fact("The fee is €50 per tonne", "€50 per tonne")]).orphan_count, 1);
  assert.equal(scanGateA("The fee is €50 per tonne.", [fact("The fee is €50 per tonne", "€50 per tonne")]).orphan_count, 0);
  assert.equal(scanGateA("A fund of €15 million.", [fact("A fund of €150 million")]).orphan_count, 1);
  assert.equal(scanGateA("A fund of €15 million.", [fact("A fund of EUR 15 000 000")]).orphan_count, 0, "the same quantity in another spelling is backed");
  assert.equal(scanGateA("15% of fleet.", [fact("15.5% of fleet")]).orphan_count, 1);
  assert.equal(scanGateA("15% of fleet.", [fact("115% of fleet")]).orphan_count, 1);
});

test("a figure is backed inside ONE claim, not by digits scattered across the joined corpus", () => {
  const two = [fact("The cap is 15 tonnes", "The cap is 15 tonnes"), fact("A fee of EUR 20", "A fee of EUR 20")];
  assert.equal(scanGateA("A fee of EUR 15 applies.", two).orphan_count, 1, "15 belongs to a mass claim, EUR 20 to the fee");
  assert.equal(scanGateA("The cap is 15 tonnes.", two).orphan_count, 0);
});

test("a figure the parser cannot read is an orphan with its reason, never silently dropped", () => {
  const scan = scanGateA("Subsidy of €5m in total.", [fact("Subsidy of €5m in total")]);
  assert.equal(scan.orphan_count, 1);
  assert.match(scan.orphans[0]?.reason ?? "", /closed set/);
  const mixed = scanGateA("Annual cap 9,000 tonnes; table 1,95 t/TEU and 10.0 tonnes per TEU.", [fact("Annual cap 9,000 tonnes")]);
  assert.ok(mixed.orphans.some((o) => o.token.startsWith("9,000") && /mixes number conventions/.test(o.reason ?? "")), "9,000 in a document that mixes conventions cannot be read");
});

test("the locale is the document's: a claim from a decimal-comma capture backs the same quantity in an English brief", () => {
  assert.equal(scanGateA("The default is 0.89 t CO2/t clinker.", [fact("Le facteur est 0,890 t CO2/t clinker", undefined, "fr")]).orphan_count, 0);
  assert.equal(scanGateA("The default is 8.9 t CO2/t clinker.", [fact("Le facteur est 0,890 t CO2/t clinker", undefined, "fr")]).orphan_count, 1);
});

test("deadline tokens are covered at a numeral boundary: 30 June 2025 is not inside 130 June 2025", () => {
  assert.equal(scanGateA("Reports are due by 30 June 2025.", [fact("Reports are due by 130 June 2025")]).orphan_count, 1);
  assert.equal(scanGateA("Reports are due by 30 June 2025.", [fact("Reports are due by 30 June 2025")]).orphan_count, 0);
});

test("S-NUMERIC compares typed figures: a ten-fold error and a different scale are caught, a respelling is not", () => {
  const cases: [string, string, string, boolean][] = [
    ["ten-fold", "A fund of €15 million", "a fund of €150 million", true],
    ["a different amount", "EUR 75 000 applies", "EUR 50 000 applies", true],
    ["a respelling of the amount", "EUR 75 000 applies", "up to EUR 75,000 applies", false],
    ["a respelling of the percentage", "a fee of 5%", "a fee of 5 per cent", false],
    ["5 is not inside 15", "a fee of 5%", "a fee of 15 per cent", true],
    ["an obligation year stands at a numeral boundary", "applies from 2027", "applies from 20270", true],
    ["the year in its own sentence", "applies from 2027", "Applies from 2027.", false],
    ["unreadable is a miss, not a pass", "A subsidy of €5m", "A subsidy of €5m", true],
  ];
  const facts = cases.map(([, claim_text, source_span], i) => ({ id: `f${i}`, claim_kind: "FACT", claim_text, source_span, source_id: "s", source_tier_at_grounding: 1 }));
  const held = new Set(mintGates(facts, { itemFloor: 2 }).numericHeldIds);
  cases.forEach(([what, , , expectHeld], i) => assert.equal(held.has(`f${i}`), expectHeld, what));
});

test("S-NUMERIC is a HARD hold: the held ids come back beside the S-CONFLATE ids", () => {
  const facts = [
    { id: "n1", claim_kind: "FACT", claim_text: "Fee of EUR 75 000", source_span: "Fee of EUR 50 000", source_id: "s", source_tier_at_grounding: 1 },
    { id: "ok", claim_kind: "FACT", claim_text: "Fee of EUR 50 000", source_span: "Fee of EUR 50 000", source_id: "s", source_tier_at_grounding: 1 },
  ];
  const rep = mintGates(facts, { itemFloor: 2 });
  assert.deepEqual(rep.numericHeldIds, ["n1"]);
  assert.equal(rep.numericFacts.length, 1);
});

test("slots: a word is matched as a word, a stop word names no topic, and one shared word is not coverage", () => {
  const slots = [{ slot_key: "penalty_level", description: "The maximum penalty level that applies with each breach" }];
  assert.equal(uncoveredSlots("The costume department closed.", [{ slot_key: "cost", description: "cost" }]).length, 1, "cost is not in costume");
  assert.equal(uncoveredSlots("Operators with ships that call at ports.", slots).length, 1, "with and that are stop words");
  assert.equal(uncoveredSlots("The penalty is high.", slots).length, 1, "one distinctive word is not enough when the slot has several");
  assert.equal(uncoveredSlots("The maximum penalty level is EUR 50 000.", slots).length, 0);
  assert.equal(uncoveredSlots("anything at all", [{ slot_key: "x", description: "with that from" }]).length, 1, "a slot with no distinctive word cannot be shown covered");
  assert.equal(uncoveredSlots("See [penalty_level] below.", slots).length, 0, "the bracketed key covers it");
  const noms = nominateForSlot("monitoring cost", [{ url: "u", text: "The costume of the monitoring officers is described in this clause of the annex." }], "cost");
  assert.deepEqual(noms.map((n) => n.url), ["u"], "monitoring is a whole word; cost is not found inside costume");
  assert.equal(decideSlotClaim({ slotKey: "k", nomination: null, confirmed: false, proseCovers: false }).kind, "GAP");
});
