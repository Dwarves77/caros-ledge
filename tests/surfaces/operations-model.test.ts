// P2-12 Operations: the pure models. The envelope gate and the index (INV-229), the statements (INV-230, with the dropped-verdict count), the labour chain with its per-hour and one-currency checks
// (INV-231: the unit error of the old tree), the S3/S4 gate over the item's whole jurisdiction list (INV-233), the one region rule, the dimension list and the assistant block.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOperationsAskContext, regionalFactLine, stateCostLine } from "@/features/operations/ask-context";
import { DIMENSION_COUNT_WORD, DIMENSIONS, dimensionLabel } from "@/features/operations/model/dimensions";
import { computeLabourChain, extractLabourChainTerms, type LabourFactLike } from "@/features/operations/model/labour-chain";
import { checkMatrixEligibility, eligibilityUnavailable, omitNote } from "@/features/operations/model/matrix-eligibility";
import { buildRegionGrid, factHeadline, formatEnvelopedValue, impliedBaseFact, indexAgainstBase, isEnvelopedFact, toMatrixFact, type OperationsFact } from "@/features/operations/model/region-grid";
import { regionsForItem } from "@/features/operations/model/region-resolve";
import { buildStatements, hasVerdictWord, humaniseFactLabel, NEEDS_SECOND_REGION } from "@/features/operations/model/statements";

const fact = (o: Partial<OperationsFact> = {}): OperationsFact => ({
  regionCode: "EU", dimension: "labor_markets", factLabel: "EU - Labour cost", value: "", status: null, trend: null, sourceName: "Eurostat", sourceUrl: null, sourceTier: 1, sourceNote: null, lastUpdated: "2026-01-01", freshness: "current",
  valueNumeric: 40.4, unit: "EUR/hour", currency: "EUR", derivation: "observed", originClass: "official", sourceKey: "eurostat", sourceRef: "lc_lci_lev", nObservations: null, methodVersion: "v1", asAtDate: "2025-01-01", referencePeriod: "2025", ...o,
});

test("INV-229: a number renders as an indexed figure only with value AND unit; the index refuses a unit mismatch and a zero base; the implied base is the first enveloped fact", () => {
  assert.equal(isEnvelopedFact({ valueNumeric: 5, unit: null }), false, "a value with no unit is a malformed envelope");
  assert.equal(isEnvelopedFact({ valueNumeric: Number.NaN, unit: "EUR" }), false);
  assert.equal(isEnvelopedFact({ valueNumeric: 5, unit: "EUR" }), true);
  assert.equal(indexAgainstBase({ valueNumeric: 50, unit: "EUR/hour" }, { valueNumeric: 100, unit: "EUR/hour" }), 50);
  assert.equal(indexAgainstBase({ valueNumeric: 50, unit: "USD/hour" }, { valueNumeric: 100, unit: "EUR/hour" }), null, "an index across units is noise");
  assert.equal(indexAgainstBase({ valueNumeric: 50, unit: "EUR/hour" }, { valueNumeric: 0, unit: "EUR/hour" }), null, "a zero base divides by nothing");
  assert.equal(indexAgainstBase({ valueNumeric: 50, unit: null }, { valueNumeric: 100, unit: "EUR/hour" }), null);
  const first = { valueNumeric: 2, unit: "x" };
  assert.equal(impliedBaseFact([{ valueNumeric: 1, unit: null }, null, first, { valueNumeric: 3, unit: "x" }]), first);
  assert.equal(formatEnvelopedValue({ valueNumeric: 12.3456, unit: "EUR/hour", nObservations: 3 }), "12 EUR/hour", "rounded to what three observations support");
  assert.equal(formatEnvelopedValue({ valueNumeric: 5, unit: null }), null);
});

test("INV-229: the headline splits a figure from prose at 24 characters with a digit; a sentence is never the headline figure", () => {
  assert.equal(factHeadline(fact({ valueNumeric: null, unit: null, value: "EUR 12 / hr" })).figure, "EUR 12 / hr");
  const sentence = factHeadline(fact({ valueNumeric: null, unit: null, value: "EPR compliance costs reached GBP 1.1 billion in 2023 across the market" }));
  assert.equal(sentence.figure, null);
  assert.match(sentence.prose ?? "", /^EPR compliance/);
  assert.equal(factHeadline(fact({ valueNumeric: null, unit: null, value: "" })).figure, null);
  const card = toMatrixFact(fact({ freshness: "frozen" }), fact({ valueNumeric: 20 }));
  assert.deepEqual([card.figure, card.indexVsBase, card.sourceTier, card.period], ["40 EUR/hour", 202, 1, "2025"]);
  assert.match(card.provenance, /frozen/, "a fact past its cadence says so");
  assert.equal(toMatrixFact(fact({ freshness: "current" }), null).provenance.includes("current"), false);
});

test("the grid drops a fact for an unknown region or dimension, counts coverage from the facts and reconciles (never silently prefers) the stored coverage rows", () => {
  const g = buildRegionGrid({
    regionKeys: ["EU", "US"], sourcedDimensions: ["labor_markets", "infrastructure"],
    facts: [fact(), fact({ regionCode: "MARS" }), fact({ dimension: "weather" })],
    coverageRows: [{ regionCode: "EU", dimension: "labor_markets", state: "populated", factCount: 2, notes: null }, { regionCode: "US", dimension: "infrastructure", state: "missing", factCount: 0, notes: null }],
    crossRefCountsByRegion: { EU: 7 },
  });
  assert.deepEqual([g.fillRate.filled, g.fillRate.total, g.fillRate.pct], [1, 4, 25]);
  assert.deepEqual(g.emptyRegions, ["US"]);
  assert.deepEqual(g.reconciliation.disagreed, [{ cell: "EU|labor_markets", claimed: 2, actual: 1 }]);
  assert.deepEqual([g.reconciliation.checked, g.reconciliation.agreed], [2, 1]);
  assert.equal(g.regionCoverage[0]?.crossReferenceCount, 7);
  assert.equal(buildRegionGrid({ regionKeys: ["EU"], sourcedDimensions: ["labor_markets"], facts: [], crossRefCountsByRegion: null }).regionCoverage[0]?.crossReferenceCount, null, "a failed count is null, never 0");
});

const ROSTER = [{ code: "EU", label: "European Union", displayOrder: 1 }, { code: "US", label: "United States", displayOrder: 2 }, { code: "UK", label: "United Kingdom", displayOrder: 3 }];
test("INV-230: a statement needs two regions and a sourced-grade origin; one region is the stated absence; a verdict-word label is COUNTED, not silently dropped; ineligible origins never enter", () => {
  const out = buildStatements({
    regions: ROSTER, dimensions: ["labor_markets"],
    facts: [
      fact({ factLabel: "EU - Labour cost" }),
      fact({ regionCode: "US", factLabel: "US - Labour cost", valueNumeric: 60, unit: "EUR/hour", sourceName: "BLS" }),
      fact({ regionCode: "UK", factLabel: "UK - Labour cost", originClass: "modelled" }),
      fact({ factLabel: "EU - Cheaper warehouse hire rate" }),
      fact({ regionCode: "US", factLabel: "US - Cheaper warehouse hire rate", valueNumeric: 9 }),
      fact({ factLabel: "EU - Only here", valueNumeric: 3 }),
    ],
  });
  const labour = out.statements.find((s) => s.factLabel === "Labour cost");
  assert.deepEqual(labour?.components.map((c) => c.regionCode), ["EU", "US"], "the modelled UK fact is not a component");
  assert.match(labour?.sentence ?? "", /^Labour cost: European Union 40 EUR\/hour \(Eurostat, 2025\), index 100 \(base European Union = 100\); United States 60 EUR\/hour \(BLS, 2025\), index 149 \(base European Union = 100\)\. United Kingdom: not available\.$/);
  const lone = out.statements.find((s) => s.factLabel === "Only here");
  assert.deepEqual([lone?.sentence, lone?.absence], [null, NEEDS_SECOND_REGION]);
  assert.equal(out.droppedVerdicts, 1, "the 'Cheaper ... hire' label is counted");
  assert.equal(out.statements.some((s) => /cheaper/i.test(s.factLabel)), false);
  assert.equal(hasVerdictWord("Should you automate"), true);
  assert.equal(hasVerdictWord("Hiring and recruitment cost"), false, "hiring is a labour-chain term, not advice");
  assert.equal(humaniseFactLabel("EU - labour_cost", "EU"), "Labour cost");
});

test("INV-230: an index applies to every component or none (a unit or currency mix gives none); one fact per region by a total order, not by input order", () => {
  const mixed = buildStatements({ regions: ROSTER, dimensions: ["labor_markets"], facts: [fact(), fact({ regionCode: "US", factLabel: "US - Labour cost", currency: "USD", unit: "EUR/hour" })] });
  assert.equal(mixed.statements[0]?.index, undefined);
  assert.deepEqual(mixed.statements[0]?.components.map((c) => c.index), [null, null]);
  const a = buildStatements({ regions: ROSTER, dimensions: ["labor_markets"], facts: [fact({ originClass: "derived", valueNumeric: 1 }), fact({ valueNumeric: 2 }), fact({ regionCode: "US", factLabel: "US - Labour cost" })] });
  const b = buildStatements({ regions: ROSTER, dimensions: ["labor_markets"], facts: [fact({ regionCode: "US", factLabel: "US - Labour cost" }), fact({ valueNumeric: 2 }), fact({ originClass: "derived", valueNumeric: 1 })] });
  assert.equal(a.statements[0]?.components[0]?.value, 2, "official outranks derived");
  assert.deepEqual(a.statements[0]?.components.map((c) => c.value), b.statements[0]?.components.map((c) => c.value));
});

const L = (label: string, value: number, unit: string, extra: Partial<LabourFactLike> = {}): LabourFactLike => ({ factLabel: label, valueNumeric: value, unit, currency: unit.split("/")[0] ?? null, sourceKey: "bls", ...extra });
const COMPLETE: LabourFactLike[] = [L("Base wage hourly median", 20, "USD/hour"), L("Employer social contributions", 5, "USD/hour"), L("Leave and absence", 2, "USD/hour"), L("Turnover and recruitment", 1, "USD/hour"), L("Shift premium", 2, "USD/hour"), { factLabel: "Productive hours per year", valueNumeric: 2, unit: "hours" }];
test("INV-231: the chain is the sum of five per-hour terms over a positive divisor; running subtotals are null from the first gap; nothing is defaulted", () => {
  const { input, causes } = extractLabourChainTerms(COMPLETE);
  const r = computeLabourChain(input, causes);
  assert.deepEqual([r.suppressed, r.numeratorTotal, r.finalValue, r.finalUnit], [false, 30, 15, "USD per productive hour"]);
  assert.deepEqual(r.terms.map((t) => t.runningSubtotal), [20, 25, 27, 28, 30, null]);
  const gap = computeLabourChain(extractLabourChainTerms(COMPLETE.filter((f) => !/Leave|Shift/.test(f.factLabel ?? ""))).input);
  assert.equal(gap.suppressed, true);
  assert.deepEqual(gap.terms.map((t) => t.runningSubtotal), [20, 25, null, null, null, null]);
  assert.match(gap.gapReason ?? "", /Leave and absence, Shift premium/, "every missing term is named");
});

test("INV-231: the annual wage is NOT a base wage (the old unit error); only an annual figure held is a named cause; a zero divisor and a mix of currencies suppress", () => {
  const annualFirst = [L("Annual median wage", 60000, "USD/year"), ...COMPLETE.slice(1)];
  const { input, causes } = extractLabourChainTerms(annualFirst);
  const r = computeLabourChain(input, causes);
  assert.equal(r.suppressed, true);
  assert.equal(r.finalValue, null, "never 'USD/year per productive hour'");
  assert.equal(r.terms[0]?.present, false);
  assert.match(r.terms[0]?.cause ?? "", /held only as USD\/year, not per hour/);
  assert.match(computeLabourChain(...Object.values(extractLabourChainTerms(COMPLETE.map((f) => (f.factLabel === "Productive hours per year" ? { ...f, valueNumeric: 0 } : f))))).gapReason ?? "", /Productive hours/);
  const mixed = extractLabourChainTerms(COMPLETE.map((f) => (f.factLabel === "Leave and absence" ? L("Leave and absence", 2, "EUR/hour") : f)));
  const m = computeLabourChain(mixed.input, mixed.causes);
  assert.equal(m.suppressed, true);
  assert.deepEqual(m.currencyMismatch, ["USD", "EUR"]);
  assert.match(m.gapReason ?? "", /different currencies \(USD, EUR\)/);
  assert.match(computeLabourChain({}).terms[0]?.cause ?? "", /no figure held/);
});

const CITEM = { jurisdictions: ["EU"] };
test("INV-233: S3/S4 need two sourced regions INCLUDING the item's own, over the item's whole jurisdiction list; otherwise the note says why; a failed read gates closed and says so", () => {
  const roster = [{ code: "EU", isoCodes: ["DE", "FR"] }, { code: "US", isoCodes: ["US-CA"] }, { code: "UK", isoCodes: ["GB"] }];
  const cov = (r: string, d = "labor_markets", state = "populated") => ({ regionCode: r, dimension: d, state });
  assert.equal(checkMatrixEligibility({ roster, coverage: [cov("EU")], item: CITEM }).s3Eligible, false, "one sourced region");
  assert.equal(checkMatrixEligibility({ roster, coverage: [cov("US"), cov("UK")], item: CITEM }).s3Eligible, false, "two regions without the item's own");
  const ok = checkMatrixEligibility({ roster, coverage: [cov("EU"), cov("US", "labor_markets", "partial")], item: CITEM });
  assert.deepEqual([ok.s3Eligible, ok.s4Eligible, ok.resolvedRegionCodes], [true, true, ["EU"]]);
  assert.equal(checkMatrixEligibility({ roster, coverage: [cov("EU"), cov("US", "labor_markets", "missing")], item: CITEM }).s3Eligible, false, "a missing row is not sourced");
  // The whole list: an item naming GB and DE is in two regions; the old page passed one value.
  assert.deepEqual(checkMatrixEligibility({ roster, coverage: [], item: { jurisdictionIso: ["DE"], jurisdictions: ["GB"] } }).resolvedRegionCodes, ["EU", "UK"]);
  assert.equal(checkMatrixEligibility({ roster, coverage: [cov("UK"), cov("US")], item: { jurisdictions: ["GB"] } }).s3Eligible, true, "the item's own region is found through the later code");
  assert.match(omitNote("3", checkMatrixEligibility({ roster, coverage: [], item: CITEM })), /no dimension has sourced data/);
  assert.match(omitNote("4", checkMatrixEligibility({ roster, coverage: [cov("US"), cov("UK")], item: CITEM })), /needs EU to have sourced coverage/);
  assert.match(omitNote("3", checkMatrixEligibility({ roster, coverage: [cov("EU")], item: CITEM })), /at least two regions/);
  assert.match(omitNote("3", checkMatrixEligibility({ roster, coverage: [cov("EU")], item: { jurisdictions: ["JP"] } })), /does not/);
  const down = eligibilityUnavailable("the coverage read failed");
  assert.deepEqual([down.s3Eligible, down.dimensions.every((d) => !d.eligible)], [false, true]);
  assert.match(omitNote("3", down), /could not be read/);
});

test("one region rule: an item belongs to every region holding any of its codes, in roster order; an item naming none belongs to none", () => {
  const roster = [{ code: "EU", isoCodes: ["DE", "NL"] }, { code: "US", isoCodes: ["US-CA"] }];
  assert.deepEqual(regionsForItem(roster, { jurisdictionIso: ["nl", "US-CA"] }), ["EU", "US"]);
  assert.deepEqual(regionsForItem(roster, { jurisdictions: ["EU"] }), ["EU"]);
  assert.deepEqual(regionsForItem(roster, { jurisdiction: "us" }), ["US"]);
  assert.deepEqual(regionsForItem(roster, {}), []);
  assert.deepEqual(regionsForItem(roster, { jurisdiction: "Atlantis" }), []);
});

test("the seven dimensions, once: the key list, the D numbers from the list's order (never a filtered subset) and the count word", () => {
  assert.equal(DIMENSIONS.length, 7);
  assert.equal(DIMENSIONS[6]?.db, "grid_intensity");
  assert.equal(dimensionLabel(DIMENSIONS[3]!), "D4 Materials sourcing");
  assert.equal(DIMENSION_COUNT_WORD, "seven");
});

test("the assistant block: the header is computed from the roster against the facts held; an enveloped line states value, origin, as-of and source; a legacy line states its text; nothing is invented", () => {
  const legacy = fact({ regionCode: "UK", valueNumeric: null, unit: null, value: "GBP 40-42k / yr", status: "stable", trend: "up", sourceName: null, sourceNote: "Office for National Statistics", lastUpdated: "2026-05-28T10:00:00Z" });
  const block = buildOperationsAskContext({ regionCodes: ["EU", "US", "UK"], regionalFacts: [fact(), legacy], stateCostFacts: [{ stateCode: "US-CA", stateLabel: "California", factLabel: "Minimum wage", value: "16.50", unit: "USD/hour", trend: null, statuteCitation: "Cal. Lab. Code 1182.12", sourceName: null, effectiveDate: "2026-01-01" }] });
  assert.match(block, /Regions with sourced Operations data: EU, UK\. US: no sourced Operations data yet\./);
  assert.match(regionalFactLine(fact()), /value: 40.4 EUR\/hour EUR \| origin: official \| derivation: observed \| as of: 2025-01-01 \| source: Eurostat/);
  assert.match(regionalFactLine(legacy), /value: GBP 40-42k \/ yr \| status: stable \| trend: up \| source: Office for National Statistics \| last updated: 2026-05-28/);
  assert.match(stateCostLine({ stateCode: "TX", stateLabel: null, factLabel: "x", value: "1", unit: null, trend: null, statuteCitation: null, sourceName: null, effectiveDate: null }), /source: no canonical source on record \| effective: unknown/);
  assert.match(buildOperationsAskContext({ regionCodes: [], regionalFacts: [], stateCostFacts: [] }), /No Operations region roster available\.[\s\S]*\(none fetched\)[\s\S]*\(none fetched\)/);
  assert.match(block, /Cal\. Lab\. Code 1182\.12|source: Cal/);
});
