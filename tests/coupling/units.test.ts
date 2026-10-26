// CONNECT-2 PR A scope review G3: one unit map (src/core/parse/data/statutory-units.json) read by statutoryUnit; the pattern facts and the DERIVE-2 writer both normalise through it, so a figure stated in prose and a value stored under a canonical token compare. An unknown unit is excluded and counted, never guessed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { statutoryUnit } from "@/core/parse";
import { DETECTORS, factOf, PATTERNS, type Fact, type PatternInput } from "@/core/flywheel/patterns";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const input = (facts: Fact[]): PatternInput => ({ now: NOW, facts, related: () => [], flow: null });

test("every listed prose and prefixed form normalises to its canonical token", () => {
  const table: [string, string][] = [
    ["EUR 2 400 per tonne", "EUR/t"], ["EUR/t", "EUR/t"], ["EUR per tonne", "EUR/t"], ["€ per tonne", "EUR/t"],
    ["EUR per equivalent metric ton of VLSFO", "EUR/t VLSFO-eq"], ["MJ per metric ton of VLSFO", "MJ/t VLSFO"], ["calendar year", "year"], ["Wh/kg", "Wh/kg"], ["kWh", "kWh"], ["1/h", "1/h"], ["gCO2e/tonne-km", "gCO2e/tkm"],
    ["EUR/tCO2e", "EUR/tCO2e"], ["EUR per tonne of CO2e", "EUR/tCO2e"], ["EUR per tCO2e", "EUR/tCO2e"],
    ["gCO2e/MJ", "gCO2e/MJ"], ["grams of CO2 equivalent per MJ", "gCO2e/MJ"],
    ["%", "pct"], ["percent", "pct"], ["pct", "pct"],
    ["EUR/GJ", "EUR/GJ"], ["EUR per GJ", "EUR/GJ"],
    ["t", "t"], ["tonnes", "t"], ["MW", "MW"], ["megawatts", "MW"], ["months", "months"], ["month", "months"],
  ];
  for (const [raw, unit] of table) assert.equal(statutoryUnit(raw), unit, raw);
});

test("an unknown or empty unit is null and is never guessed", () => {
  for (const raw of ["bananas per hectare", "", "   ", "a fine of two thousand"]) assert.equal(statutoryUnit(raw), null, raw);
  assert.equal(statutoryUnit("t shirts"), null, "an exact form matches the whole text, not a leading token");
});

test("a planted P5 pair: a ceiling stated as 'EUR 2 400 per tonne' meets an abatement stored as 'EUR/t'; an unknown unit leaves the row out and says so", () => {
  const ceilingRow = { computation_id: "k1", computed_at: "2026-10-01", result: 2400, result_unit: "EUR per tonne" };
  const abateRow = { value_id: "a1", asserted_at: "2026-10-01", value: 2300, unit: "EUR/t" };
  const ceiling = factOf("statutory_computations", ceilingRow, ["e1"]);
  const abate = factOf("derived_values", abateRow, ["e1"]);
  assert.equal(ceiling?.unit, "EUR/t");
  assert.equal(abate?.unit, "EUR/t");
  const tech: Fact = { table: "research_assessments", pk: "t1", role: "tech", entities: ["e1"], modes: [], surface: "research", at: null, due: null, source: null, tier: null, qty: null, unit: null, trl: PATTERNS.penaltyAbatement.minTrl, kind: "FACT", group: null };
  const found = DETECTORS.penaltyAbatement(input([tech, ceiling as Fact, abate as Fact]));
  assert.equal(found.length, 1, "the two stated in different spellings of one unit compare");
  const unknown = factOf("statutory_computations", { ...ceilingRow, result_unit: "bananas per hectare" }, ["e1"]);
  assert.equal(unknown?.qty, null, "the quantity is left out");
  assert.equal(unknown?.unitUnknown, true, "and the row says why");
  assert.deepEqual(DETECTORS.penaltyAbatement(input([tech, unknown as Fact, abate as Fact])), []);
});

test("a ratchet's figure is read in the canonical unit from the obligation's own statutory maximum", () => {
  const f = factOf("obligation_objects", { obligation_id: "o1", first_deadline: "2027-01-01", statutory_maximum: "up to EUR 2 400 per tonne" }, ["e1"]);
  assert.equal(f?.qty, 2400);
  assert.equal(f?.unit, "EUR/t");
});

test("review F1: a pattern resting on a display_only abatement cost is graded display_only, one resting on an analysis_ok cost analysis_ok", async () => {
  const { factOf, gradeOf } = await import("@/core/flywheel/patterns");
  const row = (admissibility: string) => ({ value_id: "a1", asserted_at: "2026-10-01", value: 95, unit: "EUR/tCO2e", admissibility, lifecycle: "verified" });
  const shown = factOf("derived_values", row("display_only"), ["e1"]) as Fact;
  const fine = factOf("derived_values", row("analysis_ok"), ["e1"]) as Fact;
  assert.equal(shown.displayOnly, true);
  assert.equal(fine.displayOnly, undefined);
  assert.equal(gradeOf([shown, fine]), "display_only", "any display-grade evidence grades the pattern down");
  assert.equal(gradeOf([fine]), "analysis_ok");
});
