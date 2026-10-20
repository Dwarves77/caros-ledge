// INV-R2a-1: every unit and factor rule (U1-U13) of the methods register parses its worked example to the stated value, or refuses with the stated reason.
// Rows are the T-rows of docs/audits/2026-10-20-market-methods-gap.md section 4 (inputs and expected outputs only; no licence-red prose).
import assert from "node:assert/strict";
import { test } from "node:test";

import { figuresEqual, findFigures, findIdentifiers, isFigure, kindOf, resolveLocale, sameIdentifier, type Figure } from "@/core/parse";

import { isRefusal, parseFigure } from "../_support/parse-figure.ts";

const fig = (text: string, locale: string | null = "en"): Figure => {
  const p = parseFigure(text, { locale });
  assert.ok(isFigure(p), `${text} (${locale}) should parse: ${JSON.stringify(p)}`);
  return p;
};

test("U1: the locale is the document's; the register's own glyphs read to the value the register states", () => {
  assert.equal(fig("15 000 t", "fr").value, "15000", "space-grouped thousands");
  assert.equal(fig("0,890 t", "fr").value, "0.89");
  assert.equal(fig("0,890 t", "fr").sigDigits, 3, "the trailing zero is a printed digit");
  assert.equal(fig("9,000 t", "en").value, "9000", "UK style: comma thousands");
  assert.equal(fig("9,000 t", "fr").value, "9", "the SAME glyphs in a decimal-comma document are 9.000");
  assert.equal(fig("0.5 t", "en").value, "0.5");
  assert.equal(fig("1,95 t/TEU", "fr").value, "1.95");
  assert.equal(fig("3,114 g CO2/g fuel", "fr").value, "3.114", "MRV Annex I: 3,114 is 3.114");
  assert.equal(fig("1,430 kg CO2e/kg", "en").value, "1430", "GLEC: 1,430 is 1430");
  assert.equal(fig("28,771.6 kg CO2e", "en").value, "28771.6");
  assert.equal(fig("40 976,5 t CO2", "fr").value, "40976.5", "space thousands plus decimal comma (T15)");
  assert.equal(fig("1.234,56 t", "de").value, "1234.56");
  assert.equal(fig("15 000 t", "fr").value, "15000", "no-break space");
  assert.equal(fig("15 000 t", "fr").value, "15000", "narrow no-break space");
});

test("U1: a reading the locale does not allow is REFUSED, never repaired", () => {
  const en = parseFigure("0,890 t", { locale: "en" });
  assert.ok(isRefusal(en) && /leading group/.test(en.reason), JSON.stringify(en));
  const fr = parseFigure("1.5 t", { locale: "fr" });
  assert.ok(isRefusal(fr) && /not a digit-group separator/.test(fr.reason), JSON.stringify(fr));
  const grouping = parseFigure("1,95 t", { locale: "en" });
  assert.ok(isRefusal(grouping) && /groups of three/.test(grouping.reason), JSON.stringify(grouping));
});

test("U1: a document that mixes conventions has no locale; a literal both readings agree on still reads, an ambiguous one is refused with the reason", () => {
  const mixed = "Table: 1,95 t/TEU light, 2,7 t/TEU heavy; text: 10.0 tonnes per TEU, 6.0 tonnes per TEU light.";
  const verdict = resolveLocale(mixed);
  assert.equal(verdict.locale, null, "T12: both separators in one report");
  const hits = findFigures(`${mixed} The cap is 9,000 tonnes.`);
  const nine = hits.find((h) => (isFigure(h.result) ? h.result.literal : h.result.literal).startsWith("9,000"));
  assert.ok(nine && isRefusal(nine.result) && /mixes number conventions/.test(nine.result.reason), "9,000 means 9000 or 9.000: the document cannot say");
  const unambiguous = findFigures(mixed).flatMap((h) => (isFigure(h.result) ? [h.result.value] : []));
  assert.ok(unambiguous.includes("1.95") && unambiguous.includes("10"), `unambiguous literals still read: ${unambiguous.join(",")}`);
});

test("U1: a majority convention resolves the document; no evidence uses the stated default; a declared locale wins", () => {
  assert.deepEqual(resolveLocale("1.234,56 t then 2,5 t and 3,4 t and 5,5 t"), { locale: "de", basis: "detected" });
  assert.deepEqual(resolveLocale("only 15 000 t here"), { locale: "en", basis: "default" });
  assert.deepEqual(resolveLocale("0.5 t", "fr"), { locale: "fr", basis: "declared" });
});

test("U2: the closed unit set carries the GLEC annex constants exactly (equal by the comparator, to the last digit)", () => {
  const eq = (a: string, b: string) => assert.ok(figuresEqual(fig(a), fig(b)), `${a} equals ${b}`);
  const ne = (a: string, b: string) => assert.ok(!figuresEqual(fig(a), fig(b)), `${a} does not equal ${b}`);
  eq("1 mile", "1.609344 km");
  eq("1 nmi", "1.852 km");
  eq("1 ft", "0.3048 m");
  eq("1 yd", "0.9144 m");
  eq("1 short ton", "0.90718474 t");
  eq("1 long ton", "1.016047 t");
  eq("1 lb", "0.000453592 t");
  eq("1 US gal", "3.785411784 l");
  eq("1 kWh", "3.6 MJ");
  ne("1 mile", "1.609 km");
  ne("1 short ton", "0.907 t");
  assert.equal(fig("0.907 184 74 t").value, "0.90718474", "T11: digits grouped by spaces on both sides of the decimal point");
  assert.equal(fig("3.785 411 784 l").value, "3.785411784");
  assert.equal(fig("1.016 047 t").value, "1.016047");
  assert.equal(parseFigure("1 FEU", { locale: "en" }).hasOwnProperty("refused"), true, "FEU = 2 TEU is on no page read: it is not in the set");
});

test("U3: intensity kinds are distinct types and never equal across kinds; the same kind compares exactly across its units", () => {
  const tkm = fig("49.9 g CO2e/tkm");
  const teuKm = fig("49.9 g CO2e/TEU-km");
  assert.notEqual(tkm.kind, teuKm.kind);
  assert.equal(figuresEqual(tkm, teuKm), false, "the same number per tonne-km and per TEU-km is not one quantity");
  assert.equal(kindOf(fig("0.15 kg CO2e/l").parts), "emission:CO2e/volume");
  assert.notEqual(fig("97 g CO2e/MJ").kind, fig("97 g CO2e/l").kind);
  assert.ok(figuresEqual(fig("97 g CO2e/MJ"), fig("349.2 g CO2e/kWh")), "T7: energy intensities of one kind compare exactly: 97 g/MJ is 349.2 g/kWh");
  assert.notEqual(fig("12 kg CO2e/t throughput").kind, fig("12 kg CO2e/tkm").kind, "a hub figure is its own kind");
});

test("U4: the boundary travels with the number (T9)", () => {
  const a = fig("WTT 0.328 kg CO2e/tkm");
  const b = fig("TTW 1.244 kg CO2e/tkm");
  const c = fig("WTW 1.572 kg CO2e/tkm");
  assert.deepEqual([a.boundary, b.boundary, c.boundary], ["WTT", "TTW", "WTW"]);
  assert.equal(fig("a headline of 1.572 kg CO2e/tkm").boundary, undefined, "no label stated: none is invented");
  assert.equal(fig("1.244 kg CO2e/tkm (tank-to-wheel)").boundary, "TTW", "a TTW value is never labelled WTW");
  assert.equal(fig("1.572 kg CO2e/tkm, well-to-wheel").boundary, "WTW");
});

test("U5: the GWP set is recorded; two CO2e figures with different sets are a series break, not comparable", () => {
  const ar5 = fig("100 t CO2e (AR5 100-year GWP)");
  assert.equal(ar5.gwpSet, "AR5");
  assert.equal(fig("100 t CO2e").gwpSet, undefined);
});

test("U5, U6: the GWP set is recorded; the literal's significant digits are stored", () => {
  assert.equal(fig("100 t CO2e (AR5 100-year GWP)").gwpSet, "AR5");
  assert.equal(fig("100 t CO2e").gwpSet, undefined);
  assert.equal(fig("1.572 kg CO2e/tkm").sigDigits, 4);
  assert.equal(fig("0.0048 kg CO2e/tkm").sigDigits, 2);
  assert.equal(fig("10.0 t").sigDigits, 3);
  assert.equal(fig("0.15948315 kg").sigDigits, 8, "a stored value keeps all eight digits (T18)");
});

test("U8, U9: distance and mass basis are recorded when stated, never inferred", () => {
  assert.equal(fig("658 km (shortest feasible distance)").distanceBasis, "SFD");
  assert.equal(fig("a great circle distance of 9,000 km").distanceBasis, "GCD");
  assert.equal(fig("1,200 t of actual mass").massBasis, "actual");
  assert.equal(fig("1,200 kg of chargeable weight").massBasis, "chargeable");
  assert.equal(fig("789,600 tkm").distanceBasis, undefined);
});

test("U10: a printed zero is a zero and unreadable text is a refusal, never a zero (INV-R2a-5)", () => {
  const zero = parseFigure("0 t");
  assert.ok(isFigure(zero) && zero.value === "0", "a printed zero is a zero");
  for (const t of ["TBM", "N/A", "-", "not_set", "nonsense"]) assert.ok(isRefusal(parseFigure(t)), `${t} is a refusal, not a zero`);
});

test("U12: regulation numbers print as 2025/2547 or 32026R1030 and resolve to one identifier", () => {
  const celex = findIdentifiers("CELEX 32026R1030")[0];
  const printed = findIdentifiers("Regulation (EU) 2026/1030")[0];
  const bare = findIdentifiers("see 2026/1030 for details")[0];
  assert.ok(celex && printed && bare);
  assert.equal(celex.key, printed.key);
  assert.ok(sameIdentifier(celex, printed) && sameIdentifier(celex, bare));
  assert.equal(findIdentifiers("Regulation (EU) 2025/2547")[0]?.key, findIdentifiers("32025R2547")[0]?.key);
  assert.equal(findIdentifiers("Regulation (EC) No 1907/2006")[0]?.key, "instrument:2006/1907", "number/year order of the older scheme");
});

test("U13: Scope 3 category, method and framework are typed when stated; a spend-based figure is screening grade by rule", () => {
  const f = fig("7,300 kg CO2e (Category 4, spend-based, GLEC Framework v3.0)");
  assert.equal(f.scope3Category, 4);
  assert.equal(f.method, "spend");
  assert.equal(f.screeningGrade, true);
  assert.equal(f.framework, "GLEC 3.0");
  assert.equal(fig("1,600 kg CO2e (Category 9, distance-based)").screeningGrade, undefined);
  assert.equal(fig("12 kg CO2e (TOC)").hubKind, "TOC");
});

test("the register's worked inputs parse to the stated numbers (T1-T15 inputs)", () => {
  const v = (t: string, l = "en") => fig(t, l).value;
  assert.equal(v("760,000 kg CO2e"), "760000");
  assert.equal(v("0.498 kg CO2e/tkm"), "0.498");
  assert.equal(v("789,600 tkm"), "789600");
  assert.equal(v("349.2 g CO2e/kWh"), "349.2");
  assert.equal(v("321.75 kg CO2e"), "321.75");
  assert.equal(v("1,430 kg CO2e/kg"), "1430");
  assert.equal(v("10.48 t CO2e"), "10.48");
  assert.equal(v("144 900 t clinker", "fr"), "144900");
  assert.equal(v("0,863 t CO2/t clinker", "fr"), "0.863");
  assert.equal(fig("0,863 t CO2/t clinker", "fr").functionalUnit, "clinker");
  assert.equal(v("50 976,5 t CO2", "fr"), "50976.5");
  assert.equal(v("0,820 t CO2/t cement", "fr"), "0.82");
  assert.equal(v("EUR 2 400 per tonne"), "2400");
  assert.equal(v("49.9 g CO2e/TEU-km"), "49.9");
  assert.equal(v("96.6 gCO2e/MJ"), "96.6");
  assert.equal(v("€15 million"), "15000000");
  assert.equal(v("$2.5bn"), "2500000000");
  assert.equal(fig("128.7 g CO2e/TEU-km").kind, "emission:CO2e/activity_teu_km");
});

test("a currency amount with an unknown scale suffix is refused, not read at face value (EUR 5m is not EUR 5)", () => {
  const p = parseFigure("€5m", { locale: "en" });
  assert.ok(isRefusal(p) && /closed set/.test(p.reason), JSON.stringify(p));
});
