// The unit matcher, the exact decimal arithmetic and the whole-word matcher, asserted directly: what each reads, and what it refuses to read.
import assert from "node:assert/strict";
import { test } from "node:test";

import { aliasAlternation, escapeRe, GAS_ALTERNATION, GAS_BY_ALIAS, IDENT_FILE, LOCALES, MINUS_CLASS, QUALIFIER_FILE, SCALE_ALTERNATION, SCALE_BY_WORD, SEP_CLASS, SPACE_CLASS, UNIT_BY_ID, UNITS, unitOfAlias, unitsOfDim } from "@/core/parse/data";
import { addDec, decToString, mulDec, parseDec, shiftDec } from "@/core/parse/decimal";
import { canonicalRatio, isTrajectoryUnit, matchUnit, moneyBefore } from "@/core/parse/unit";
import { contentWords, hasWord } from "@/core/parse/words";

const dec = (s: string) => parseDec(s) as NonNullable<ReturnType<typeof parseDec>>;

test("decimal arithmetic is exact: 0.1 + 0.2 is 0.3, a scale word shifts the digits", () => {
  assert.equal(decToString(addDec(dec("0.1"), dec("0.2"))), "0.3");
  assert.equal(decToString(mulDec(dec("1.5"), dec("2"))), "3");
  assert.equal(decToString(shiftDec(dec("2.5"), 6)), "2500000");
});

test("the unit matcher reads the longest unit expression at the start of the text, and nothing else", () => {
  const teu = matchUnit("g CO2e/TEU-km in 2024");
  assert.deepEqual([teu?.length, teu?.unit, teu?.kind], [13, "g CO2e/teu_km", "emission:CO2e/activity_teu_km"]);
  const clinker = matchUnit("t CO2/t clinker");
  assert.deepEqual([clinker?.unit, clinker?.functionalUnit], ["t CO2/t", "clinker"]);
  assert.equal(matchUnit("kWh")?.kind, "energy");
  assert.equal(matchUnit("zzz"), null, "text that is not in the closed set matches nothing");
});

test("a currency written before a number is read only where it starts: the eur ending Valeur is part of a word", () => {
  assert.deepEqual(moneyBefore("a fee of €"), { unit: "eur", length: 1 });
  assert.deepEqual(moneyBefore("EUR "), { unit: "eur", length: 4 });
  assert.equal(moneyBefore("Valeur"), null);
});

test("unit constants are exact ratios; money and shares are the trajectory units", () => {
  const kg = canonicalRatio(dec("3"), { n: "kg" });
  assert.deepEqual([decToString(kg.num), decToString(kg.den)], ["0.003", "1"], "3 kg is 0.003 t");
  assert.equal(isTrajectoryUnit("eur"), true);
  assert.equal(isTrajectoryUnit("t"), false);
});

test("alias lookup: a symbol is exact-case, a word is not; the alternation tries the longest alias first", () => {
  assert.equal(unitOfAlias("kWh")?.id, "kWh");
  assert.equal(unitOfAlias("TONNES")?.id, "t");
  assert.equal(unitOfAlias("g")?.id, "g");
  assert.equal(unitOfAlias("G"), null, "G is not grams");
  assert.ok(unitsOfDim(["mass"]).some((u) => u.id === "t"));
  const alt = aliasAlternation(unitsOfDim(["mass"])).split("|");
  assert.ok(alt.indexOf("tonnes") < alt.indexOf("t"));
  assert.equal(escapeRe("a.b*c"), "a\\.b\\*c");
  assert.ok(UNITS.length > 0 && LOCALES.en && LOCALES.fr);
});

test("a word is matched as a whole word, and stop words name no topic", () => {
  assert.equal(hasWord("sulphur oxides", "oxides"), true);
  assert.equal(hasWord("sulphur oxides", "oxide"), false, "oxide is not inside oxides");
  assert.equal(hasWord("SB-2610 applies", "SB-261"), false);
  assert.deepEqual([...contentWords("the cost of the fuel with that")].sort(), ["cost", "fuel"]);
});

test("the rule tables build the classes and alternations the parser reads with", () => {
  assert.equal(UNIT_BY_ID.get("t")?.dim, "mass");
  assert.equal(GAS_BY_ALIAS.get("CO2e"), "CO2e");
  assert.ok(new RegExp(`^(?:${GAS_ALTERNATION})$`, "i").test("CO2e"));
  assert.equal(SCALE_BY_WORD.get("million")?.exp, 6);
  assert.ok(new RegExp(`^(?:${SCALE_ALTERNATION})$`, "i").test("million"));
  assert.ok(new RegExp(`^[${SEP_CLASS}]$`).test(",") && new RegExp(`^[${SEP_CLASS}]$`).test("."));
  assert.ok(new RegExp(`^[${SPACE_CLASS}]$`).test(" "), "a no-break space groups digits");
  assert.ok(new RegExp(`^[${MINUS_CLASS}]$`).test("-") && new RegExp(`^[${MINUS_CLASS}]$`).test("−"));
  assert.ok(IDENT_FILE.schemes.length > 0 && IDENT_FILE.yearBounds[0] < IDENT_FILE.yearBounds[1]);
  assert.ok(QUALIFIER_FILE.fields.boundary, "the boundary qualifier phrases are data");
});
