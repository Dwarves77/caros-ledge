// CARBON-1: the carbon cost per FEU and its four inputs are produced by the propagate stage of the one turn, never typed. INV-CBN-2 (a missing input is a named absence, never a figure), INV-CBN-3 (method version and basis on every value;
// a changed input recomputes the cost in the next turn), INV-CBN-4 (a display-grade cost is refused for a filing by the ceiling). Each is asserted on the rows the fixture turn wrote, and the page reads the same rows.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runTurn } from "@/core/turn";
import { readCarbonInputs } from "@/core/derived/carbon";
import { assertUse } from "@/core/derived/ceiling";
import { portPosition } from "@/core/entities";
import { admissibleFor } from "@/core/propagation";
import type { Value } from "@/core/propagation/types";
import { buildCarbonCards } from "@/features/market/lib/carbon";
import { readMarket } from "@/features/market/read";
import { CarbonCostSection } from "@/features/market/ui/CarbonCostSection";

import { renderApp, textOf } from "../_support/render.ts";

import { BARCELONA_ROTTERDAM, carbonFixture, EUA, FACTOR, NOW, PAYLOAD, propagate, removeRows, SHANGHAI_ROTTERDAM as SHA, state, value } from "./_world.ts";

/** The great-circle distance the way the test computes it (not the method's code): the haversine over the two positions in the port table. */
function greatCircleKm(a: string, b: string): number {
  const [p, q] = [portPosition(a), portPosition(b)] as [{ lat: number; lon: number }, { lat: number; lon: number }];
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(q.lat - p.lat) / 2) ** 2 + Math.cos(r(p.lat)) * Math.cos(r(q.lat)) * Math.sin(r(q.lon - p.lon) / 2) ** 2;
  return Math.round(2 * 6371.0088 * Math.asin(Math.sqrt(h)) * 10) / 10;
}
const cost = (km: number, gPerTkm: number, tonnes: number, price: number) => (km * (gPerTkm / 1e6) * tonnes * price);

test("the fixture turn computes the cost of a corridor from the series, the factor, the payload default and the two ports, each input a derived value with its method version and basis", async () => {
  const f = carbonFixture();
  const r = await propagate(f);
  assert.equal(r.exit, 0);
  const km = greatCircleKm("CNSHA", "NLRTM");
  assert.ok(km > 8800 && km < 9200, `Shanghai to Rotterdam is about 8,900 km by the great circle (got ${km})`);

  const want: Array<[string, string, string, number, string]> = [
    ["market", "price", "carbon_price_eur_t@1.0.0", 70, "eex-eua:primary-auction, observed 2026-10-14"],
    ["market", "payload", "feu_payload_tonnes@1.0.0", 14, "feu-payload:default, observed 2026-09-01"],
    ["mode:ocean", "intensity", "carbon_intensity_tkm@1.0.0", 16, "the ocean modal-default factor"],
    [SHA, "distance", "corridor_distance_km@1.0.0", km, "great-circle, not routed: CNSHA to NLRTM"],
  ];
  for (const [scope, input, method, v, basis] of want) {
    const s = state(f, scope, input);
    assert.ok(s?.value_id, `${input} has a value`);
    assert.equal(s.method_version, method);
    assert.equal(s.basis, basis);
    assert.equal(Number(value(f, s.value_id).value), v, input);
    assert.equal(value(f, s.value_id).method_version, "1.0.0");
  }
  const c = state(f, SHA, "cost");
  const dv = value(f, c?.value_id);
  assert.ok(Math.abs(Number(dv.value) - cost(km, 16, 14, 70)) < 1e-9, "distance x intensity x payload x price");
  assert.deepEqual([dv.method_id, dv.unit, dv.currency, c?.method_version], ["carbon_cost_per_feu", "EUR/FEU", "EUR", "carbon_cost_per_feu@1.0.0"]);
  assert.equal(c?.basis, "distance x emission intensity x payload per FEU x carbon price");
  assert.deepEqual((dv.inputs as Array<{ table: string }>).map((i) => i.table), ["derived_values", "derived_values", "derived_values", "derived_values"], "the cost names the four values it was computed from");

  // The ledger row of the stage carries the counts: one corridor has a figure, the other waits for a port position.
  const counts = (f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outputs as { counts: Record<string, number> }).counts;
  assert.deepEqual([counts.carbon_corridors, counts.carbon_cost_figures, counts.carbon_missing_distance], [2, 1, 1]);
  assert.equal(counts.carbon_values_written, 5, "four inputs (the price and the payload once, the distance once, the intensity once) and the cost");
});

test("INV-CBN-2: a missing input yields an absent cost that names the input, never a figure; the section keeps its slot and says why", async () => {
  const f = carbonFixture({ series: [EUA()] });
  await propagate(f);
  const c = state(f, SHA, "cost");
  assert.equal(c?.value_id, null);
  assert.equal(c?.absent_reason, "missing: payload per FEU (no permitted payload default captured)");
  assert.equal(state(f, "market", "payload")?.absent_reason, "no permitted payload default captured");
  assert.equal(f.db.rows("derived_values").filter((v) => v.method_id === "carbon_cost_per_feu").length, 0, "no cost value was written");

  const barcelona = state(f, BARCELONA_ROTTERDAM, "distance");
  assert.equal(barcelona?.absent_reason, "no port position recorded for ESBCN", "the unmatched code is named");
  assert.equal(state(f, BARCELONA_ROTTERDAM, "cost")?.absent_reason, "missing: distance (no port position recorded for ESBCN), payload per FEU (no permitted payload default captured)");

  const none = carbonFixture({ series: [], factors: [] });
  await propagate(none);
  assert.equal(state(none, "market", "price")?.absent_reason, "no ETS price series captured");
  assert.equal(state(none, "mode:ocean", "intensity")?.absent_reason, "no modal-default emission factor for the ocean mode");

  // The page: the corridor card draws the sentence in the slot of the figure, with the section on the page and the four inputs each stated.
  const store = await readCarbonInputs(f.db.client);
  const html = textOf(renderApp(CarbonCostSection({ cards: buildCarbonCards([{ entityId: SHA, label: "Shanghai to Rotterdam, ocean", parsed: { origin: "CNSHA", dest: "NLRTM", mode: "ocean" } }], store) })));
  assert.match(html, /Carbon cost per FEU/);
  assert.match(html, /missing: payload per FEU \(no permitted payload default captured\)/);
  assert.match(html, /Payload per FEU\s*: no permitted payload default captured/);
  assert.match(html, /Carbon price\s*: 70 EUR\/tCO2e/);
  assert.doesNotMatch(html, /EUR \d/, "no figure is drawn for a cost that is missing an input");
});

test("INV-CBN-3: a changed input is recomputed by the next propagate stage: the price is superseded, the cost follows with the new lineage, and an unchanged turn writes nothing", async () => {
  const f = carbonFixture();
  await propagate(f);
  const first = state(f, SHA, "cost")?.value_id;
  const firstPrice = state(f, "market", "price")?.value_id;
  const again = await propagate(f);
  assert.equal(f.db.rows("derived_values").length, 5, "an unchanged turn writes no value");
  assert.equal(state(f, SHA, "cost")?.value_id, first);
  const countsOf = (family: string, n: number) => (f.db.rows("harness_runs").filter((x) => x.family === family)[n]?.outputs as { counts: Record<string, number> }).counts;
  assert.deepEqual([countsOf("propagation", 1).carbon_values_written, countsOf("propagation", 1).carbon_states_written], [0, 0]);
  assert.equal(again.exit, 0);

  // A later allowance observation at a new price lands in market_series.
  f.db.seed("market_series", [EUA(80, "2026-10-21", { id: "e0000000-0000-4000-8000-000000000009" })]);
  await propagate(f);
  const price = { ...state(f, "market", "price") };
  assert.notEqual(price.value_id, firstPrice);
  assert.equal(Number(value(f, price.value_id).value), 80);
  assert.equal(price.basis, "eex-eua:primary-auction, observed 2026-10-21");
  assert.equal(value(f, firstPrice).lifecycle, "superseded", "the old price is no longer a current statement");
  assert.equal(value(f, price.value_id).supersedes, firstPrice, "the new price names the one it replaces");
  const next = state(f, SHA, "cost")?.value_id;
  assert.notEqual(next, first);
  assert.ok(Math.abs(Number(value(f, next).value) - cost(greatCircleKm("CNSHA", "NLRTM"), 16, 14, 80)) < 1e-9, "the cost is recomputed at the new price");
  assert.equal(value(f, next).supersedes, first);
  assert.ok((value(f, next).inputs as Array<{ pk: string }>).some((i) => i.pk === price.value_id), "its lineage names the new price value");

  // The input goes away (the payload row is gone): the cost becomes an absence and the figure it held stands no longer.
  removeRows(f, "market_series", (r) => r.series_key === "feu-payload:default");
  await propagate(f);
  assert.equal(state(f, SHA, "cost")?.value_id, null);
  assert.equal(value(f, next).lifecycle, "superseded");
});

test("INV-CBN-4: a display-grade cost is refused for a filing by the ceiling; only a cost whose four inputs are all filing-grade is statutory-grade", async () => {
  // Distance is a great-circle figure, calculation-grade at most, and the allowance series' source here is unrated: display-grade.
  const f = carbonFixture({ series: [EUA(70, "2026-10-14", { source_key: "eex" }), PAYLOAD(14, { source_key: "eex" })] });
  await propagate(f);
  const dv = value(f, state(f, SHA, "cost")?.value_id);
  assert.equal(dv.admissibility, "display_only");
  assert.deepEqual(assertUse(dv as never, "filing"), { ok: false, reason: "above its ceiling (display_only)" });
  assert.deepEqual(assertUse(dv as never, "display"), { ok: true });
  const asValue = { valueId: String(dv.value_id), entityId: SHA, methodId: "carbon_cost_per_feu", methodVersion: "1.0.0", value: Number(dv.value), valueLow: null, valueHigh: null, unit: "EUR/FEU", currency: "EUR", derivation: dv.derivation, originClass: "derived", lifecycle: dv.lifecycle, admissibility: dv.admissibility, baseConfidence: Number(dv.base_confidence), assertedAt: NOW.toISOString(), halfLifeDays: null, inputs: [], supersedes: null, computedAt: NOW.toISOString(), computedBy: "t" } as unknown as Value;
  assert.equal(admissibleFor(asValue, "filing", NOW).ok, false, "the one gate refuses it for a filing");
  assert.equal(admissibleFor(asValue, "display", NOW).ok, true);
  const card = buildCarbonCards([{ entityId: SHA, label: "x", parsed: { origin: "CNSHA", dest: "NLRTM", mode: "ocean" } }], await readCarbonInputs(f.db.client))[0];
  assert.equal(card?.grade, "display", "the card draws the display grade");
});

test("the Market page reads the same rows: the reader returns the carbon store beside the corridors, and a failed read of the table is a failed part, not an empty one", async () => {
  const f = carbonFixture();
  await propagate(f);
  const read = await readMarket(f.db.client);
  assert.ok(read.carbon.ok && read.corridors.ok);
  if (read.carbon.ok && read.corridors.ok) {
    const cards = buildCarbonCards(read.corridors.data, read.carbon.data);
    assert.deepEqual(cards.map((c) => [c.entityId, c.cost.value ? "figure" : "absent"]), [[SHA, "figure"], [BARCELONA_ROTTERDAM, "absent"]]);
    assert.equal(cards[0]?.cost.value?.currency, "EUR");
  }
  const failing = carbonFixture();
  await propagate(failing);
  failing.db.fail("carbon_inputs", "select", "read refused");
  const bad = await readMarket(failing.db.client);
  assert.equal(bad.carbon.ok, false, "the failed read is the part's failure");
  assert.equal(bad.corridors.ok, true, "the corridor names still stand");
});

test("dry plans the same counts as apply and writes no value and no state", async () => {
  const counts = (f: Awaited<ReturnType<typeof carbonFixture>>) => {
    const out = f.db.rows("harness_runs").find((x) => x.family === "propagation")?.outputs as { counts?: Record<string, number>; planned?: Record<string, number> };
    return out.counts ?? out.planned ?? {};
  };
  const dry = carbonFixture();
  await runTurn({ stage: "propagate", mode: "dry", input: {} }, { d: dry.d, env: {}, now: () => NOW });
  assert.deepEqual([dry.db.rows("carbon_inputs").length, dry.db.rows("derived_values").length], [0, 0]);
  const applied = carbonFixture();
  await propagate(applied);
  const pick = (c: Record<string, number>) => Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith("carbon_")));
  assert.deepEqual(pick(counts(dry)), pick(counts(applied)));
  assert.equal(pick(counts(dry)).carbon_cost_figures, 1);
});

test("the intensity is the one modal-default factor of the corridor's mode: with two for the mode none is picked and the absence says so (INV-255); the cost names it", async () => {
  const f = carbonFixture({ factors: [FACTOR, { ...FACTOR, factor_id: "f0000000-0000-4000-8000-000000000002", vehicle_class: "bulk_carrier" }] });
  await propagate(f);
  assert.equal(state(f, "mode:ocean", "intensity")?.absent_reason, "more than one modal-default factor for the ocean mode, so none is picked");
  assert.equal(state(f, SHA, "cost")?.absent_reason, "missing: emission intensity (more than one modal-default factor for the ocean mode, so none is picked)");
});

test("a value the drain recomputed is adopted, never duplicated: the new price's insert event stales the cost, the drain of the next stage recomputes it, and the step holds that successor", async () => {
  const f = carbonFixture();
  await propagate(f);
  f.db.seed("market_series", [EUA(80, "2026-10-21", { id: "e0000000-0000-4000-8000-000000000009" })]);
  await propagate(f);
  const cost = String(state(f, SHA, "cost")?.value_id);
  const price = String(state(f, "market", "price")?.value_id);
  // The database trigger on derived_values emits the insert of the new price; the drain of the next stage walks its edges, stales the cost computed from it and registers the successor.
  f.db.rows("propagation_events").push({ event_id: 9100, occurred_at: NOW.toISOString(), table_name: "derived_values", row_pk: price, entity_id: null, change_kind: "insert", new_row: { ...value(f, price) }, drained_at: null });
  const before = f.db.rows("derived_values").length;
  await propagate(f);
  const successor = f.db.rows("derived_values").find((v) => v.supersedes === cost);
  assert.ok(successor, "the drain registered the successor of the staled cost");
  assert.equal(value(f, cost).admissibility, "stale");
  assert.equal(f.db.rows("derived_values").length, before + 1, "one value, the drain's: the step registered nothing again");
  assert.equal(state(f, SHA, "cost")?.value_id, successor.value_id, "the pointer moved to the live successor");
  assert.equal(value(f, cost).lifecycle, "superseded");
  const cards = buildCarbonCards([{ entityId: SHA, label: "x", parsed: { origin: "CNSHA", dest: "NLRTM", mode: "ocean" } }], await readCarbonInputs(f.db.client));
  assert.equal(cards[0]?.cost.value?.valueId, successor.value_id, "the page reads the successor");
});
