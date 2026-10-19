// INV-R2a-1: every unit and factor rule (U1-U13) of the methods register parses its worked example to the stated value, or refuses with the stated reason.
// Rows are the T-rows of docs/audits/2026-10-20-market-methods-gap.md section 4 (inputs and expected outputs only; no licence-red prose).
import assert from "node:assert/strict";
import { test } from "node:test";

import { boundarySumWithin, checkBoundaries, checkWorkedExample, convertValue, convertViaBridge, displayFigure, displayValue, figureOf, findFigures, isFigure, isRefusal, kindOf, parseCnCode, parseFigure, parsePhaseIn, resolveLocale, sameIdentifier, findIdentifiers, storedValue, withinPublishedDigit, type Figure, type Parsed } from "@/core/parse";
import { parseDec } from "@/core/parse/decimal";
import { MISSING_FILE } from "@/core/parse/data";

const fig = (text: string, locale: string | null = "en"): Figure => {
  const p: Parsed = parseFigure(text, { locale });
  assert.ok(isFigure(p), `${text} (${locale}) should parse: ${JSON.stringify(p)}`);
  return p;
};
const dec = (s: string) => parseDec(s) as NonNullable<ReturnType<typeof parseDec>>;

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

test("U2: the closed unit set carries the GLEC annex constants exactly", () => {
  const conv = (v: string, from: string, to: string, sig: number) => {
    const r = convertValue(dec(v), { n: from }, { n: to }, sig);
    assert.ok(r.ok);
    return r.ok ? `${r.value.n}e-${r.value.s}` : "";
  };
  assert.equal(conv("1", "mile", "km", 7), "1609344e-6");
  assert.equal(conv("1", "nmi", "km", 4), "1852e-3");
  assert.equal(conv("1", "ft", "m", 4), "3048e-4");
  assert.equal(conv("1", "yd", "m", 4), "9144e-4");
  assert.equal(conv("1", "short_ton", "t", 8), "90718474e-8");
  assert.equal(conv("1", "long_ton", "t", 7), "1016047e-6");
  assert.equal(conv("1", "lb", "t", 6), "453592e-9");
  assert.equal(conv("1", "gal_us", "l", 10), "3785411784e-9");
  assert.equal(conv("1", "kWh", "MJ", 2), "36e-1");
  assert.equal(fig("0.907 184 74 t").value, "0.90718474", "T11: digits grouped by spaces on both sides of the decimal point");
  assert.equal(fig("3.785 411 784 l").value, "3.785411784");
  assert.equal(fig("1.016 047 t").value, "1.016047");
  assert.equal(parseFigure("1 FEU", { locale: "en" }).hasOwnProperty("refused"), true, "FEU = 2 TEU is on no page read: it is not in the set");
});

test("U3: intensity kinds are distinct types; tkm and TEU-km never convert implicitly, only through a named bridge row with its source", () => {
  const tkm = fig("49.9 g CO2e/tkm");
  const teuKm = fig("49.9 g CO2e/TEU-km");
  assert.notEqual(tkm.kind, teuKm.kind);
  assert.equal(kindOf(fig("0.15 kg CO2e/l").parts), "emission:CO2e/volume");
  assert.notEqual(fig("97 g CO2e/MJ").kind, fig("97 g CO2e/l").kind);
  const refused = convertValue(dec("49.9"), tkm.parts, teuKm.parts, 3);
  assert.ok(!refused.ok && /never convert implicitly/.test(refused.reason), "tkm to TEU-km needs the cited tonnes per TEU");
  const bridged = convertViaBridge(dec("49.9"), tkm.parts, teuKm.parts, "teu_mass_average", 3);
  assert.ok(bridged.ok && bridged.value.n === 499n && bridged.value.s === 0, "10 t per TEU: 49.9 g/tkm is 499 g/TEU-km");
  const back = convertViaBridge(dec("499"), teuKm.parts, tkm.parts, "teu_mass_average", 3);
  assert.ok(back.ok && back.value.n === 499n && back.value.s === 1, "and back");
  assert.ok(!convertViaBridge(dec("1"), tkm.parts, fig("1 g CO2e/MJ").parts, "teu_mass_average", 3).ok);
  assert.ok(!convertViaBridge(dec("1"), tkm.parts, teuKm.parts, "no_such_bridge", 3).ok);
  // T7: energy intensities of one kind convert exactly: 97 g/MJ is 349.2 g/kWh
  const kwh = convertValue(dec("97"), fig("97 g CO2e/MJ").parts, fig("1 g CO2e/kWh").parts, 4);
  assert.ok(kwh.ok && `${kwh.value.n}e-${kwh.value.s}` === "3492e-1");
  // a hub figure is its own kind
  assert.notEqual(fig("12 kg CO2e/t throughput").kind, fig("12 kg CO2e/tkm").kind);
});

test("U4: the boundary travels with the number and WTT + TTW = WTW within the last published digit or the figure is withheld (T9)", () => {
  const a = fig("WTT 0.328 kg CO2e/tkm");
  const b = fig("TTW 1.244 kg CO2e/tkm");
  const c = fig("WTW 1.572 kg CO2e/tkm");
  assert.deepEqual([a.boundary, b.boundary, c.boundary], ["WTT", "TTW", "WTW"]);
  assert.deepEqual(checkBoundaries(a, b, c), { ok: true });
  const wrong = checkBoundaries(a, b, fig("WTW 1.58 kg CO2e/tkm"));
  assert.ok(!wrong.ok && /within the last published digit/.test(wrong.reason));
  assert.deepEqual(boundarySumWithin({ value: "0.84", decimals: 2 }, { value: "3.18", decimals: 2 }, { value: "4.02", decimals: 2 }), { ok: true });
  assert.ok(!boundarySumWithin({ value: "0.84", decimals: 2 }, { value: "3.18", decimals: 2 }, { value: "4.10", decimals: 2 }).ok);
  assert.ok(!checkBoundaries(c, b, a).ok, "labels must be WTT, TTW, WTW in that role");
  assert.equal(fig("a headline of 1.572 kg CO2e/tkm").boundary, undefined, "no label stated: none is invented");
  assert.equal(fig("1.244 kg CO2e/tkm (tank-to-wheel)").boundary, "TTW", "a TTW value is never labelled WTW");
  assert.equal(fig("1.572 kg CO2e/tkm, well-to-wheel").boundary, "WTW");
});

test("U5: the GWP set is recorded; two CO2e figures with different sets are a series break, not comparable", () => {
  const ar5 = fig("100 t CO2e (AR5 100-year GWP)");
  assert.equal(ar5.gwpSet, "AR5");
  assert.equal(fig("100 t CO2e").gwpSet, undefined);
});

test("U6: the literal's significant digits are stored and a display never prints more", () => {
  assert.equal(fig("1.572 kg CO2e/tkm").sigDigits, 4);
  assert.equal(fig("0.0048 kg CO2e/tkm").sigDigits, 2);
  assert.equal(fig("10.0 t").sigDigits, 3);
  assert.equal(displayValue("1.7875", 3, "en"), "1.79");
  assert.equal(displayValue("0.00448", 3, "en"), "0.00448");
  assert.equal(displayValue("15000000", 2, "en"), "15,000,000");
  const kgToT = convertValue(dec("4.48"), { n: "kg" }, { n: "t" }, 3);
  assert.ok(kgToT.ok && kgToT.value.n === 448n && kgToT.value.s === 5, "4.48 kg is 0.00448 t: three significant digits survive the conversion, no more");
  assert.equal(displayFigure(fig("49.9 g CO2e/TEU-km"), "en"), "49.9 g CO2e/TEU-km");
  assert.equal(displayFigure(fig("€15 million"), "en"), "EUR 15,000,000");
  assert.equal(displayFigure(fig("15.5%"), "en"), "15.5%");
  assert.equal(displayFigure(fig("0,890 t", "fr"), "fr"), "0,890 t".replace("0,890", "0,89"), "0,89: the value without padding zeros it was never printed with");
  // T8: the print 1.787 is the truncation of 1.7875; they agree within half a unit of the last published digit, a different value does not
  assert.ok(withinPublishedDigit(fig("1.787 kg"), fig("1.7875 kg")));
  assert.ok(!withinPublishedDigit(fig("1.787 kg"), fig("1.80 kg")));
});

test("U7: a worked example whose arithmetic holds but whose printed unit contradicts it resolves by the arithmetic and raises source_unit_defect (T2, T3)", () => {
  const t2 = checkWorkedExample({ factor: fig("0.2 kg CO2e/TEU-km"), quantities: [fig("2 t"), fig("2,000 km")], result: fig("800 kg CO2e") });
  assert.ok(t2.ok && t2.sourceUnitDefect && t2.resolvedKind === "emission:CO2e/activity_tkm", JSON.stringify(t2));
  const t3 = checkWorkedExample({ factor: fig("0.04 kg CO2e/$"), quantities: [fig("$20,000")], result: fig("800 kg CO2e/$") });
  assert.ok(t3.ok && t3.sourceUnitDefect && /total/.test(t3.reasons.join(" ")), JSON.stringify(t3));
  const clean = checkWorkedExample({ factor: fig("0.2 kg CO2e/tkm"), quantities: [fig("2 t"), fig("2,000 km")], result: fig("800 kg CO2e") });
  assert.ok(clean.ok && !clean.sourceUnitDefect, "a consistent example raises no flag");
  assert.ok(!checkWorkedExample({ factor: fig("0.2 kg CO2e/tkm"), quantities: [fig("2 t"), fig("2,000 km")], result: fig("900 kg CO2e") }).ok, "arithmetic that does not reproduce the result is not resolved");
});

test("U8, U9: distance and mass basis are recorded when stated, never inferred", () => {
  assert.equal(fig("658 km (shortest feasible distance)").distanceBasis, "SFD");
  assert.equal(fig("a great circle distance of 9,000 km").distanceBasis, "GCD");
  assert.equal(fig("1,200 t of actual mass").massBasis, "actual");
  assert.equal(fig("1,200 kg of chargeable weight").massBasis, "chargeable");
  assert.equal(fig("789,600 tkm").distanceBasis, undefined);
});

test("U10: missing is typed and never 0 (TBM, N/A, a dash, not_set, M); a table may declare what its dash means", () => {
  const kinds = new Map<string, string>();
  for (const t of MISSING_FILE.tokens) {
    const p = parseFigure(t.literal);
    assert.ok("missing" in p, `${t.literal} is a typed missing value`);
    kinds.set(t.literal, (p as { missing: string }).missing);
    assert.deepEqual(storedValue(p), { value: null, unit: null, missing: t.kind }, "INV-R2a-5: stored as NULL with its kind, never the string 0");
  }
  assert.equal(new Set([kinds.get("TBM"), kinds.get("N/A"), kinds.get("-"), kinds.get("not_set"), kinds.get("M")]).size, 5, "five tokens, five kinds");
  assert.deepEqual(parseFigure("-", { missingAs: { "-": "not_set" } }), { missing: "not_set", literal: "-" }, "T17: the IMO Z dash is not_set");
  const zero = parseFigure("0 t");
  assert.ok(isFigure(zero) && zero.value === "0", "a printed zero is a zero, distinct from a missing value");
  assert.equal(storedValue(parseFigure("0 t"))?.missing, null);
  assert.equal(storedValue(parseFigure("nonsense")), null, "a refusal stores nothing");
});

test("U11: phase-ins are typed with emissions_year, surrender_year and share; a bare share-and-year is refused (T14)", () => {
  const text = "Surrender 40% of 2024 emissions (in 2025), 70% of 2025 (in 2026), 100% from 2027.";
  const r = parsePhaseIn(text, { locale: "en" });
  assert.deepEqual(r.entries.map((e) => [e.emissions_year, e.surrender_year, e.share]), [[2024, 2025, "40"], [2025, 2026, "70"]]);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0]?.reason ?? "", /emissions year or the surrender year/);
  assert.equal(parsePhaseIn("Phase-in 100% from 2026", { locale: "en" }).entries.length, 0, "spec 01 wording is ambiguous: not read as either role");
});

test("U12: CN codes keep 8 digits and the print form; regulation numbers print as 2025/2547 or 32026R1030 and resolve to one identifier", () => {
  assert.deepEqual(parseCnCode("7219 12 90"), { digits: "72191290", print: "7219 12 90" });
  assert.deepEqual(parseCnCode("72191290"), { digits: "72191290", print: "7219 12 90" });
  assert.ok("refused" in parseCnCode("7219 12"), "a subheading is not a CN code");
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
  const ratio = figureOf("0.15948315", "ratio");
  assert.ok(isFigure(ratio) && ratio.sigDigits === 8, "a stored value keeps all eight digits (T18)");
});

test("a currency amount with an unknown scale suffix is refused, not read at face value (EUR 5m is not EUR 5)", () => {
  const p = parseFigure("€5m", { locale: "en" });
  assert.ok(isRefusal(p) && /closed set/.test(p.reason), JSON.stringify(p));
});
