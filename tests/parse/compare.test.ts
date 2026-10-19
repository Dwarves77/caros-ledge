// INV-R2a-2: the ONE figure comparator rejects every substring pair of register row I2 and accepts the same quantity written another way.
// P4: two captures that give two values for one figure DISAGREE, both kept, neither picked.
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareFigures, containsNumeral, figureOf, figuresEqual, isFigure, parseFigure, reconcile, stateFigure, type Figure } from "@/core/parse";
import { cmpDec, divDec, parseDec, roundSig, sigDigitsOf, decToString } from "@/core/parse/decimal";
import { interpretNumber, scanNumbers } from "@/core/parse/locale";

const fig = (text: string, locale = "en"): Figure => {
  const p = parseFigure(text, { locale });
  assert.ok(isFigure(p), `${text} should parse: ${JSON.stringify(p)}`);
  return p;
};
const same = (a: string, b: string, locale = "en") => figuresEqual(fig(a, locale), fig(b, locale));

test("I2: a figure is never backed by a longer figure that merely contains its digits (the numeral boundary)", () => {
  const pairs: [string, string][] = [
    ["€5", "€50"], ["€15 million", "€150 million"], ["EUR 400", "EUR 2 400"], ["15%", "115%"], ["15%", "15.5%"], ["5.5%", "5%"],
    ["10 t", "10.5 t"], ["10 t", "100 t"], ["1 kg CO2e/tkm", "11 kg CO2e/tkm"], ["€1.5 million", "€15 million"], ["49.9 g CO2e/TEU-km", "149.9 g CO2e/TEU-km"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(same(a, b), false, `${a} must not equal ${b}`);
    assert.equal(same(b, a), false, `${b} must not equal ${a}`);
    assert.equal(stateFigure(`The text says ${b} in the period.`, fig(a)), false, `${a} is not stated by a text that says ${b}`);
  }
});

test("the same quantity written another way is equal (value, unit and scale, not spelling)", () => {
  const pairs: [string, string][] = [
    ["€15 million", "€15,000,000"], ["€15 million", "EUR 15 000 000"], ["5 per cent", "5%"], ["1,000 kg", "1 t"], ["0.5 t", "500 kg"], ["5 percent", "5.0%"],
    ["97 g CO2e/MJ", "349.2 g CO2e/kWh"], ["1.609344 km", "1 mile"], ["$2.5bn", "$2,500 million"],
  ];
  for (const [a, b] of pairs) assert.equal(same(a, b), true, `${a} equals ${b}`);
  assert.equal(figuresEqual(fig("0,890 t", "fr"), fig("0.89 t", "en")), true, "locale is per document: 0,890 in one and 0.89 in another is one value");
});

test("kinds, qualifiers and units that differ make two figures incomparable, not equal", () => {
  assert.equal(compareFigures(fig("49.9 g CO2e/tkm"), fig("49.9 g CO2e/TEU-km")).relation, "incomparable");
  assert.equal(compareFigures(fig("1 kg CO2e/l"), fig("1 kg CO2e/kg")).relation, "incomparable");
  assert.equal(compareFigures(fig("1 kg CO2/tkm"), fig("1 kg CO2e/tkm")).relation, "incomparable", "CO2 is not CO2e");
  assert.equal(compareFigures(fig("1.5 kg CO2e/tkm (WTW)"), fig("1.5 kg CO2e/tkm (TTW)")).relation, "incomparable", "a TTW value is not a WTW value");
  const gwp = compareFigures(fig("100 t CO2e (AR5)"), fig("100 t CO2e (AR6)"));
  assert.ok(gwp.relation === "incomparable" && /series break/.test(gwp.reason));
  assert.equal(compareFigures(fig("1 t CO2/t clinker"), fig("1 t CO2/t cement")).relation, "incomparable", "functional units differ");
  assert.equal(compareFigures(fig("5 t"), fig("5 km")).relation, "incomparable");
  assert.equal(compareFigures(fig("€5"), fig("$5")).relation, "incomparable", "currencies do not convert");
  assert.equal(compareFigures(fig("1.5 kg CO2e/tkm"), fig("1.5 kg CO2e/tkm (WTW)")).relation, "equal", "a label stated on one side only does not split a value");
});

test("stateFigure reads the haystack in its own locale: 9,000 in a UK text is 9000, in a decimal-comma capture 9.000", () => {
  assert.equal(stateFigure("Annual cap of 9,000 tonnes.", fig("9000 t")), true);
  assert.equal(stateFigure("Annual cap of 9,000 tonnes.", fig("9 t")), false);
  assert.equal(stateFigure("Valeur 9,000 t et 1,95 t/TEU", fig("9 t"), { locale: "fr" }), true);
  assert.equal(stateFigure("Jahreswert 9.000 t", fig("9000 t"), { locale: "de" }), true);
});

test("containsNumeral: a date or year is found at a numeral boundary on both sides", () => {
  assert.equal(containsNumeral("due by 30 June 2025 at the latest", "30 June 2025"), true);
  assert.equal(containsNumeral("due by 130 June 2025", "30 June 2025"), false);
  assert.equal(containsNumeral("from 2025 onward", "2025"), true);
  assert.equal(containsNumeral("a budget of 20250", "2025"), false);
  assert.equal(containsNumeral("see Regulation 2025/1735", "2025"), false, "an instrument number is not a deadline year");
  assert.equal(containsNumeral("effective 2025-06-30.", "2025-06-30"), true);
  assert.equal(containsNumeral("", "2025"), false);
});

test("P4: two primary captures giving two values for one figure DISAGREE: both kept with document and date, neither picked (T18)", () => {
  const sgfA = figureOf("0.15948315", "ratio") as Figure;
  const sgfB = figureOf("0.15405257", "ratio") as Figure;
  const obs = [
    { subject: "corsia:sgf:2024", figure: sgfA, document: "ICAO newsletter Oct 2025", date: "2025-10-01" },
    { subject: "corsia:sgf:2024", figure: sgfB, document: "ICAO Aviation Climate Week 2026 slide 9", date: "2026-03-01" },
  ];
  for (const order of [obs, [...obs].reverse()]) {
    const [r] = reconcile(order);
    assert.equal(r?.state, "disagree");
    assert.equal(r?.observations.length, 2, "both observations kept");
    assert.deepEqual(r?.observations.map((o) => o.document).sort(), ["ICAO Aviation Climate Week 2026 slide 9", "ICAO newsletter Oct 2025"]);
    assert.ok(!(r && "figure" in r), "there is no chosen figure on a disagreement: the later one is not picked");
  }
  const agree = reconcile([{ ...obs[0]!, subject: "x" }, { ...obs[0]!, subject: "x", document: "second capture", date: "2026-01-01" }]);
  assert.equal(agree[0]?.state, "agree");
  const other = reconcile([{ subject: "k", figure: fig("49.9 g CO2e/tkm"), document: "a", date: "2025-01-01" }, { subject: "k", figure: fig("49.9 g CO2e/TEU-km"), document: "b", date: "2025-01-02" }]);
  assert.equal(other[0]?.state, "incomparable");
});

test("the decimal and locale internals: exact arithmetic, whole digit runs, no float", () => {
  assert.equal(cmpDec(parseDec("0.1") as never, parseDec("0.10") as never), 0);
  assert.equal(decToString(divDec(parseDec("1") as never, parseDec("3") as never, 5) as never), "0.33333");
  assert.equal(decToString(roundSig(parseDec("0.00448") as never, 2) as never), "0.0045");
  assert.equal(decToString(roundSig(parseDec("15432") as never, 2) as never), "15000");
  assert.equal(sigDigitsOf("0,890"), 3);
  assert.equal(sigDigitsOf("15 000"), 5);
  assert.deepEqual(scanNumbers("€50 of 2019/883 and 15 000 tonnes in 2024 100 tonnes").map((t) => t.literal), ["50", "2019", "883", "15 000", "2024", "100"], "a digit run is taken whole; a 4-digit year does not absorb the next group");
  assert.deepEqual(interpretNumber("1 234,5", "fr"), { ok: true, text: "1234.5", decimals: 1 });
  assert.equal(interpretNumber("1,234.5", "fr").ok, false);
});
