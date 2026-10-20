import assert from "node:assert/strict";
import { test } from "node:test";

import { formatFigure } from "@/core/figures";
import { loadProducerRegistry } from "@/core/producers";
import { buildCarbonOverlayView, carbonIntensity, selectFactor, type FactorRow } from "@/features/market/lib/carbon";
import { computeSeriesDeltas } from "@/features/market/lib/deltas";
import { boardFreshnessSummary, deriveSeriesFreshness } from "@/features/market/lib/freshness";
import { selectHeadlineSeries } from "@/features/market/lib/headline";
import { headlineCardView } from "@/features/market/lib/headline-view";
import { buildLeadTimePosition } from "@/features/market/lib/lead-time";
import { selectNextDataDrops } from "@/features/market/lib/rail-select";
import { PRODUCERS, producerFor } from "@/features/market/lib/registry";
import { deltaCellModel, sparklineModel } from "@/features/market/lib/ribbon-model";
import { buildSeriesBoard, type SeriesRow } from "@/features/market/lib/series-board";
import { derivePromotionState } from "@/features/market/lib/signal-promotion";

import { fixture } from "../integration/world.ts";

const obs = (key: string, period: string, value: number | null, over: Partial<SeriesRow> = {}): SeriesRow => ({ id: `${key}@${period}`, series_key: key, label: key, reference_period: period, as_at_date: period, value_numeric: value, unit: "EUR/1000L", currency: "EUR", ...over });

test("formatFigure: currency symbol, redundant unit prefix stripped, a missing value is the dash with its reason and never 0", () => {
  assert.equal(formatFigure(1493.6, "EUR/1000L", "EUR").text, "€1,493.60/1000L");
  assert.equal(formatFigure("73.59", "/bbl", "USD").text, "$73.59 /bbl");
  assert.equal(formatFigure(5, "months", null).text, "5.00 months");
  assert.equal(formatFigure(2, null, "CHF").text, "2.00 CHF", "an unknown currency shows its code, never a guessed symbol");
  for (const bad of [null, undefined, "n/a", Number.NaN]) {
    const f = formatFigure(bad, "EUR/1000L", "EUR");
    assert.equal(f.text, "—");
    assert.ok(f.emptyReason);
  }
});

test("INV-252 computeSeriesDeltas: the four cases, and a missing window is never 0", () => {
  assert.equal(computeSeriesDeltas([]).count, 0);
  const one = computeSeriesDeltas([obs("a:x", "2026-03-01", 10)]);
  assert.deepEqual([one.delta1w, one.delta1m, one.deltaYoY], [null, null, null]);
  // a unit change inside the window is suppressed, never compared
  const mixed = computeSeriesDeltas([obs("a:x", "2026-03-01", 10, { unit: "USD/GAL", currency: "USD" }), obs("a:x", "2026-03-10", 11)]);
  assert.deepEqual(mixed.delta1w, { unitMismatch: true, fromDate: "2026-03-01" });
  // a zero prior makes the percent undefined (null), the change itself is still the change
  const zero = computeSeriesDeltas([obs("a:x", "2026-03-01", 0), obs("a:x", "2026-03-10", 4)]);
  assert.equal(zero.delta1w?.value, 4);
  assert.equal(zero.delta1w?.pct, null);
  // the window uses the nearest point AT OR BEFORE the window start, and a window with no prior point is insufficient history
  const rows = [obs("a:x", "2026-03-01", 100), obs("a:x", "2026-03-06", 105), obs("a:x", "2026-03-10", 110)];
  const d = computeSeriesDeltas(rows);
  assert.deepEqual([d.delta1w?.fromDate, d.delta1w?.value, d.delta1w?.pct], ["2026-03-01", 10, 10]);
  assert.deepEqual(d.delta1m, { insufficientHistory: true });
  assert.deepEqual(d.deltaYoY, { insufficientHistory: true });
  // same date twice: the later-seen row wins
  assert.equal(computeSeriesDeltas([obs("a:x", "2026-03-01", 1), obs("a:x", "2026-03-01", 2)]).latest?.value, 2);
});

test("ribbon cells: every window is a value or a named state with its SDMX code", () => {
  const rows = [obs("a:x", "2026-03-01", 100), obs("a:x", "2026-03-10", 110)];
  const d = computeSeriesDeltas(rows);
  const w = deltaCellModel(d, "1w");
  assert.deepEqual([w.kind, w.kind === "value" ? w.text : null], ["value", "▲10.0% 1w"]);
  const yoy = deltaCellModel(d, "YoY");
  assert.ok(yoy.kind === "absent" && yoy.state === "no_data_yet" && yoy.obsStatus === "H");
  assert.ok(deltaCellModel(undefined, "1m").kind === "absent");
  const m = deltaCellModel(computeSeriesDeltas([obs("a:x", "2026-03-01", 1, { currency: "USD" }), obs("a:x", "2026-03-10", 2)]), "1w");
  assert.ok(m.kind === "absent" && m.state === "suppressed" && m.obsStatus === "Q");
  const down = deltaCellModel(computeSeriesDeltas([obs("a:x", "2026-03-01", 100), obs("a:x", "2026-03-10", 90)]), "1w");
  assert.ok(down.kind === "value" && down.arrow === "▼" && down.magnitude === "10.0%", "magnitude is unsigned, the arrow carries the direction");
});

test("sparkline: one year back from the series' own latest date, sampled to 60, null under two points", () => {
  const long = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), value: i }));
  const s = sparklineModel(long);
  assert.ok(s && s.drawn === 60 && s.total <= 366 && s.to === long[399]?.date);
  assert.equal(sparklineModel([{ date: "2026-01-01", value: 1 }]), null);
  const flat = sparklineModel([{ date: "2026-01-01", value: 3 }, { date: "2026-01-08", value: 3 }]);
  assert.match(flat?.points ?? "", /,12\.00/);
});

test("INV-253 buildSeriesBoard: an unregistered prefix is kept, a not-built producer lists its rows, empty groups say why", () => {
  const rows = [obs("eu-oil-bulletin:automotive-diesel", "2026-03-01", 1400), obs("eu-oil-bulletin:automotive-diesel", "2026-03-08", 1450), obs("mystery:thing", "2026-03-08", 3, { unit: null, currency: null }), obs("sbti:near-term-lead-time-x", "2026-03-08", 40, { unit: "months", currency: null })];
  const b = buildSeriesBoard(rows);
  assert.deepEqual(b.unregistered.map((s) => s.seriesKey), ["mystery:thing"]);
  const oil = b.groups.find((g) => g.keyPrefix === "eu-oil-bulletin");
  assert.equal(oil?.state, "populated");
  assert.equal(oil?.series[0]?.observationCount, 2);
  assert.equal(oil?.series[0]?.displayValue, "€1,450.00/1000L");
  assert.equal(b.groups.find((g) => g.keyPrefix === "sbti")?.state, "not_built", "rows under a producer the registry marks unbuilt are still shown");
  assert.equal(b.groups.find((g) => g.keyPrefix === "sbti")?.series.length, 1);
  assert.equal(b.groups.find((g) => g.keyPrefix === "ecb-fx")?.state, "registered_unpopulated");
  assert.equal(b.totalObservedSeries, 3);
  assert.equal(buildSeriesBoard([]).isEmpty, true);
});

test("registry: six producers as data, their runtime side exists, and the implemented flags agree with the keys", () => {
  assert.equal(PRODUCERS.length, 6);
  assert.equal(producerFor("ecb-fx")?.cadenceDays, 1);
  const catalog = fixture().d.catalog;
  const names = new Set(Object.keys(catalog));
  for (const p of PRODUCERS) if (p.producer) assert.ok(names.has(p.producer), `${p.keyPrefix}: producer spec ${p.producer} exists`);
  const registry = loadProducerRegistry(catalog);
  for (const p of PRODUCERS) if (p.producer && registry.some((r) => r.name === p.producer)) assert.equal(registry.find((r) => r.name === p.producer)?.domain_table, "market_series");
});

test("INV-253 selectHeadlineSeries: no-delta series are excluded, families fold with a COMPUTED count, class order is fuel, carbon, fx, index, five are visible", () => {
  const mk = (key: string, v: [number, number], over: Partial<SeriesRow> = {}) => [obs(key, "2026-03-01", v[0], over), obs(key, "2026-03-08", v[1], over)];
  const rows = [
    ...mk("ecb-fx:eur-usd", [1.1, 1.2], { unit: "USD/EUR", currency: "USD" }),
    ...mk("ecb-fx:eur-gbp", [0.8, 0.9], { unit: "GBP/EUR", currency: "GBP" }),
    ...mk("ecb-fx:eur-jpy", [150, 151], { unit: "JPY/EUR", currency: "JPY" }),
    ...mk("eu-oil-bulletin:automotive-diesel", [1400, 1450]),
    ...mk("eu-oil-bulletin:heavy-fuel-oil-3-5pct", [600, 610]),
    ...mk("eu-oil-bulletin:residual-fuel-oil-1pct", [700, 690]),
    ...mk("eu-oil-bulletin:eurosuper-95", [1500, 1510]),
    ...mk("eia-v2:jet-fuel-kerosene-eer-epjk-pf4-rgc-dpg", [2, 3], { unit: "USD/GAL", currency: "USD" }),
    obs("eu-oil-bulletin:lpg-motor-fuel", "2026-03-08", 50),
    ...mk("carrier-ets:acme", [90, 95], { unit: "USD/TEU", currency: "USD" }),
    ...mk("mystery:thing", [1, 2]),
  ];
  const s = selectHeadlineSeries(buildSeriesBoard(rows));
  assert.deepEqual(s.excludedSeriesKeys, ["eu-oil-bulletin:lpg-motor-fuel"]);
  assert.equal(s.visible.length, 5);
  assert.deepEqual(s.cards.map((c) => c.familyClass), ["fuel", "fuel", "fuel", "fuel", "fuel", "carbon", "fx", "index"]);
  const fx = s.cards.find((c) => c.familyKey === "fx:ecb-reference-rates");
  assert.deepEqual([fx?.row.seriesKey, fx?.fold], ["ecb-fx:eur-usd", { count: 2, noun: "rates" }], "the fold is the family's eligible member count minus one, here 2 not the declared 4");
  assert.equal(s.cards.find((c) => c.familyKey === "fuel:jet-fuel")?.freightMode, "air");
  assert.equal(s.familiesShown, 5);
  assert.equal(s.overflow.length, 3);
  // a declared primary that has no delta hands the card to another member, with that member's own label
  const alt = selectHeadlineSeries(buildSeriesBoard([...mk("eia-v2:diesel-no2-low-sulfur-eer-epd2f-pf4-y35ny-dpg", [2, 3], { unit: "USD/GAL", currency: "USD", label: "NY diesel" }), obs("eu-oil-bulletin:automotive-diesel", "2026-03-08", 1400)]));
  assert.deepEqual([alt.cards[0]?.label, alt.cards[0]?.fold.count], ["NY diesel", 0]);
});

test("INV-258 freshness: an off-grid cadence never reads fresher than its source, null is unknown, the worst state governs, empty is unknown", () => {
  const row = { as_at_date: "2026-03-01", reference_period: "2026-03-01" };
  assert.equal(deriveSeriesFreshness(row, { cadenceDays: 7 }, "2026-03-05T10:00:00Z").code, "current");
  assert.equal(deriveSeriesFreshness(row, { cadenceDays: 7 }, "2026-03-12").code, "ageing");
  assert.equal(deriveSeriesFreshness(row, { cadenceDays: 10 }, "2026-03-12").code, "ageing", "10 days judged as weekly: 11 days old is already ageing");
  assert.equal(deriveSeriesFreshness(row, { cadenceDays: 7 }, "2026-08-01").code, "frozen");
  assert.equal(deriveSeriesFreshness(row, { cadenceDays: null }, "2026-03-05").code, "unknown");
  assert.equal(deriveSeriesFreshness(row, null, "2026-03-05").code, "unknown");
  const board = (asAt: string[]) => ({ groups: [{ state: "populated", cadenceDays: 7, series: asAt.map((d) => ({ asAtDate: d, referencePeriod: d })) }] }) as never;
  assert.equal(boardFreshnessSummary({ groups: [] }, "2026-03-12").worst, "unknown");
  const mixed = boardFreshnessSummary(board(["2026-03-10", "2026-03-01", "2025-01-01"]), "2026-03-12");
  assert.equal(mixed.worst, "frozen", "the worst state governs the panel");
  assert.equal(mixed.total, 3);
  assert.equal(deriveSeriesFreshness(row, { cadenceDays: 400 }, "2026-12-01").code, "current", "a 400-day cadence is the annual period, not an irregular one");
});

test("INV-259 next data drops: latest period plus the registered cadence, omitted when unimplemented, no cadence or no observation", () => {
  const board = buildSeriesBoard([obs("ecb-fx:eur-usd", "2026-10-14", 1.1), obs("ecb-fx:eur-usd", "2026-10-15", 1.2), obs("eu-oil-bulletin:automotive-diesel", "2026-10-12", 1400), obs("sbti:x", "2026-10-12", 3)]);
  const drops = selectNextDataDrops(board, { now: new Date("2026-10-16T00:00:00Z") });
  assert.deepEqual(drops.map((d) => [d.keyPrefix, d.dateIso]), [["ecb-fx", "2026-10-16"], ["eu-oil-bulletin", "2026-10-19"]]);
  assert.throws(() => selectNextDataDrops(board, { now: new Date("nope") }));
  assert.deepEqual(selectNextDataDrops(buildSeriesBoard([]), { now: new Date() }), []);
});

test("INV-257 lead-time position: five months-unit rows or not forecastable, another unit is excluded never converted", () => {
  const sbti = (n: number, months: number, unit = "months") => obs(`sbti:near-${n}`, "2026-03-01", months, { unit, currency: null });
  assert.deepEqual(buildLeadTimePosition([sbti(1, 10), sbti(2, 20), sbti(3, 30), sbti(4, 40)]).forecastable, false);
  const five = buildLeadTimePosition([sbti(1, 10), sbti(2, 20), sbti(3, 30), sbti(4, 40), sbti(5, 50)]);
  assert.deepEqual([five.forecastable, five.cohortMedianMonths, five.sampleSize], [true, 30, 5]);
  const wrong = buildLeadTimePosition([sbti(1, 10), sbti(2, 20), sbti(3, 30), sbti(4, 40), sbti(5, 50, "years")]);
  assert.equal(wrong.forecastable, false);
  assert.equal(wrong.sampleSize, 4);
  assert.equal(buildLeadTimePosition([sbti(1, 10), sbti(2, 20), sbti(3, 30), sbti(4, 40), sbti(5, 50), sbti(6, 60)]).cohortMedianMonths, 35);
});

const ROAD: FactorRow = { factor_id: "f-road", mode: "road", vehicle_class: "hgv", jurisdiction: "US", quantity_basis: "tonne_km", ttw_co2e: 0.1, wtw_co2e: 0.12, wtt_co2e: 0.02, source_key: "epa", derivation: "observed" };
const RAIL: FactorRow = { ...ROAD, factor_id: "f-rail", mode: "rail", ttw_co2e: 0.02 };

test("carbonIntensity: tank-to-wheel first, then well-to-wheel, then well-to-tank; a basis without a convention is refused", () => {
  assert.deepEqual(carbonIntensity(ROAD), { ok: true, valueGPerUnit: 100, unit: "gCO2e/tonne-km", basis: "tonne_km", headlineLabel: "tank-to-wheel", factorId: "f-road", sourceKey: "epa" });
  const wtw = carbonIntensity({ ...ROAD, ttw_co2e: null });
  assert.ok(wtw.ok && wtw.headlineLabel === "well-to-wheel");
  assert.equal(carbonIntensity({ ...ROAD, quantity_basis: "teu_km" }).ok, false);
  assert.equal(carbonIntensity({ ...ROAD, ttw_co2e: null, wtw_co2e: null, wtt_co2e: null }).ok, false);
  assert.equal(carbonIntensity(null).ok, false);
});

test("INV-255 selectFactor: two jurisdictions, GLOBAL, two modes without a mode, an unmatched mode never pick", () => {
  assert.equal(selectFactor([ROAD, RAIL], { jurisdictionIso: ["US", "CA"] }).state, "ambiguous");
  assert.deepEqual(selectFactor([ROAD], { jurisdictionIso: ["GLOBAL"] }), { state: "no_factor", jurisdiction: "GLOBAL", reason: "global" });
  assert.deepEqual(selectFactor([ROAD], { jurisdictionIso: [] }), { state: "no_factor", jurisdiction: null, reason: "empty" });
  assert.deepEqual(selectFactor([ROAD, RAIL], { jurisdictionIso: ["us"] }), { state: "no_factor", jurisdiction: "us", reason: "no_mode_basis" });
  assert.equal(selectFactor([ROAD, RAIL], { jurisdictionIso: ["US"], mode: "Rail" }).state, "resolved");
  assert.equal(selectFactor([ROAD], { jurisdictionIso: ["DE"] }).state, "no_factor");
  // a corridor: the mode alone, on exactly one candidate
  assert.equal(selectFactor([ROAD, RAIL], { mode: "road" }).state, "resolved");
  assert.equal(selectFactor([ROAD, { ...ROAD, factor_id: "f2" }], { mode: "road" }).state, "no_factor");
  assert.equal(selectFactor([ROAD], { mode: "ocean" }).state, "no_factor");
  assert.equal(selectFactor([ROAD, RAIL], {}).state, "no_factor");
});

test("the detail carbon block: three honest states, and a figure only from a real selection", () => {
  assert.equal(buildCarbonOverlayView({ jurisdictionIso: ["US"], factors: [ROAD], mode: "road" }).figure?.value, 0.1);
  const amb = buildCarbonOverlayView({ jurisdictionIso: ["US", "CA"], factors: [ROAD] });
  assert.deepEqual([amb.state, amb.figure], ["ambiguous", null]);
  const none = buildCarbonOverlayView({ jurisdictionIso: ["DE"], factors: [ROAD] });
  assert.ok(none.state === "no_factor" && !/yet|today|pending/i.test(none.body), "no state claim about coverage today");
});

test("INV-256 derivePromotionState: Fact only on a fact-citable origin, two citers promote to corroborated at most, an unknown code is the weakest signal", () => {
  assert.equal(derivePromotionState({ originClass: "official", independentCiters: 0 }).code, "fact");
  assert.equal(derivePromotionState({ originClass: "community", independentCiters: 3 }).code, "signal_corroborated");
  assert.equal(derivePromotionState({ originClass: "community", independentCiters: 1 }).code, "signal_unconfirmed");
  assert.equal(derivePromotionState({ originClass: "made-up", independentCiters: 9 }).code, "signal_corroborated");
  assert.equal(derivePromotionState({ originClass: "made-up" }).code, "signal_unconfirmed");
  assert.equal(derivePromotionState({ independentCiters: 5 }).code, "signal_corroborated");
  assert.equal(derivePromotionState({ independentCiters: 1 }).code, "signal_unconfirmed");
  assert.equal(derivePromotionState({}).code, "unclassified");
  assert.ok(!/pending|unscored/i.test(JSON.stringify(derivePromotionState({}))));
});

test("a headline card carries its source ref and the rating's url (the baseline shows the ref as a link)", () => {
  const board = buildSeriesBoard([
    ...["2026-08-24", "2026-08-31"].map((d, i) => ({ id: `a${i}`, series_key: "ecb-fx:eur-usd", label: "EUR/USD", reference_period: d, as_at_date: d, value_numeric: 1.05 + i * 0.05, unit: "USD/EUR", currency: "USD", derivation: "observed", origin_class: "official", source_key: "ecb", source_ref: "ECB reference rates, 2026-08-31" })),
  ]);
  const card = selectHeadlineSeries(board).cards[0];
  assert.ok(card);
  const v = headlineCardView(card, { ratings: { ecb: { sourceKey: "ecb", name: "ECB", url: "https://www.ecb.europa.eu/stats/", licence: null, attribution: null, tier: 2, via: "class" } }, nowIso: "2026-09-01T00:00:00Z" });
  assert.deepEqual([v.envelope.sourceRef, v.envelope.sourceUrl], ["ECB reference rates, 2026-08-31", "https://www.ecb.europa.eu/stats/"]);
  const v2 = headlineCardView(card, { ratings: {}, nowIso: "2026-09-01T00:00:00Z" });
  assert.match(String(v2.envelope.sourceUrl), /^https:\/\//, "with no rating the producer's own source url applies");
});

