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

test("HEAL-1c: a quoted passage in another number convention (14,5 % in a brief that reads en) is backed by a claim whose own document read the same figure; an ambiguous literal still is not", () => {
  const brief = [
    "Penalties of 28,771.6 kg CO2e, 1,234.5 kg CO2e and 12.75 tonnes were recorded, against 10.5, 3.2, 4.5, 6.25, 7.5, 8.25, 9.75 and 2.5 tonnes in 2024.",
    "— 14,5 % from 1 January 2035;",
    "The limit is calculated by reducing the reference value of 91,16 grams of CO₂ equivalent per MJ by the following percentage.",
    "The company shall pay the FuelEU penalty resulting from the multiplication of EUR 1,5 by the energy in MJ.",
    "The cap is 9,000 tonnes.",
  ].join("\n");
  const quoted = [
    fact("— 14,5 % from 1 January 2035;", "calculated by reducing the reference value of 91,16 grams of CO 2 equivalent per MJ by the following percentage: — 2 % from 1 January 2025; — 6 % from 1 January 2030; — 14,5 % from 1 January 2035;"),
    fact("shall be calculated by reducing the reference value of 91,16 grams of CO₂ equivalent per MJ by the following percentage", "reference value of 91,16 grams of CO 2 equivalent per MJ"),
    fact("the multiplication of EUR 1,5 by the energy used", "the multiplication of EUR 1,5 by the energy used"),
  ];
  const tokens = (facts: ReturnType<typeof fact>[]) => scanGateA(brief, facts).orphans.filter((o) => o.class === "figure").map((o) => o.token);
  const refused = tokens([]);
  for (const t of ["14,5 %", "91,16 grams of CO₂", "EUR 1,5"]) assert.ok(refused.includes(t), `${t} is an orphan with no claim`);
  assert.ok(scanGateA(brief, []).orphans.find((o) => o.token === "14,5 %")?.reason, "the document's locale refuses it");
  assert.deepEqual(tokens(quoted).filter((t) => ["14,5 %", "91,16 grams of CO₂", "EUR 1,5"].includes(t)), [], "backed by the claims that state them");
  assert.ok(tokens(quoted).includes("9,000 tonnes"), "a figure no claim states stays an orphan");
  assert.ok(tokens([fact("— 14,6 % from 1 January 2035;"), fact("EUR 1,6 by the energy")]).includes("14,5 %"), "a different value never backs it");
});

test("HEAL-1c: in a document that mixes number conventions (15f63ea9), a refused brief figure is backed by a claim that states the same digits in another separator form (5,000 GT against 5 000 GT with a space, NBSP or thin space); a different value, unit or kind never backs it", () => {
  // The literal inventory of the production brief: decimal-comma quotations (26,5 %, 78,4 million) beside English thousands (1,386,051,745, 5,000), so the document has no resolvable majority.
  const lits: [string, number][] = [["5,000", 5], ["10,000", 2], ["4,4", 1], ["5 000", 1], ["26,5", 2], ["51,5", 2], ["77,5", 2], ["97,5", 2], ["1,185", 1], ["1,386,051,745", 1], ["16.5", 1], ["200 000", 1], ["4,3", 1], ["4.3", 1], ["5,10", 1], ["51.5", 1], ["5,38", 1], ["78,4", 1], ["78.4", 1], ["97.5", 1]];
  const brief = [...lits.flatMap(([l, n]) => Array.from({ length: n }, () => `Value ${l} % applies.`)), "The directive reaches vessels of 5,000 GT and above.", "The cap is 9,000 tonnes."].join("\n");
  const orphan = (facts: ReturnType<typeof fact>[], tok: string) => scanGateA(brief, facts).orphans.some((o) => o.token === tok);
  assert.match(scanGateA(brief, []).orphans.find((o) => o.token === "5,000 GT")?.reason ?? "", /mixes number conventions/, "the document is refused, so the figure carries a reason");
  for (const span of ["5 000 GT", "5\u00a0000 GT", "5\u202f000 GT", "5000 GT"]) assert.equal(orphan([fact('The captured source text states the figure "x".', span)], "5,000 GT"), false, `${JSON.stringify(span)} backs 5,000 GT`);
  assert.equal(orphan([fact('the figure "5,000 GT"', "5,000 GT")], "5,000 GT"), true, "the same ambiguous literal on both sides forces nothing: it stays refused");
  assert.equal(orphan([fact("x", "6 000 GT")], "5,000 GT"), true, "a different value never backs it");
  assert.equal(orphan([fact("x", "5 000 tonnes")], "5,000 GT"), true, "a different unit never backs it");
  assert.equal(orphan([fact("x", "5 000 GT")], "9,000 tonnes"), true, "a figure no claim states stays an orphan");
  assert.equal(orphan([fact("x", "9 000 tonnes")], "9,000 tonnes"), false, "9,000 tonnes is backed by a claim that states 9 000 tonnes");
  assert.equal(orphan([fact("x", "9 000 tonnes")], "5,000 GT"), true);
});
