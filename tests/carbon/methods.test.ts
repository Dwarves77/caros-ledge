// The four carbon methods as registered (carbon_price_eur_t, feu_payload_tonnes, corridor_distance_km, carbon_cost_per_feu @1.0.0), called through the registry with the rows the stage hands them: what each accepts, what it refuses and says, and how the
// grade of the cost follows the grade of its inputs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMethodRegistry, type MethodContext, type MethodResult } from "@/core/propagation";

const registry = createMethodRegistry();
const run = (id: string, inputs: Array<{ pk?: string; row: unknown }>): MethodResult => {
  const fn = registry.get("derived_values", id, "1.0.0");
  assert.ok(fn, `${id}@1.0.0 is registered`);
  return fn({ entityId: null, inputs: inputs.map((i) => ({ table: "t", pk: i.pk ?? "k", row: i.row })), priorValue: null, now: new Date("2026-10-15T00:00:00Z") } as MethodContext) as MethodResult;
};
const obs = (over: Record<string, unknown> = {}) => ({ series_key: "eex-eua:a", value_numeric: 70, unit: "EUR/tCO2e", currency: "EUR", derivation: "observed", origin_class: "official", as_at_date: "2026-10-14", reference_period: "2026-10-14", source_tier: 2, ...over });
const refusal = (r: MethodResult): string => (r.ok ? "" : r.reason);

test("the price and the payload take the latest dated observation, in the unit the rules accept, and the rating of its source decides whether it may serve a filing", () => {
  const r = run("carbon_price_eur_t", [{ row: obs({ value_numeric: 60, as_at_date: "2026-10-07" }) }, { row: obs({ value_numeric: 75, as_at_date: "2026-10-14" }) }, { row: obs({ value_numeric: 50, as_at_date: "2026-09-30" }) }]);
  assert.ok(r.ok);
  assert.deepEqual([r.value, r.unit, r.currency, r.derivation, r.admissibility, r.basis], [75, "EUR/tCO2e", "EUR", "observed", "filing_ok", "eex-eua:a, observed 2026-10-14"]);
  const unrated = run("carbon_price_eur_t", [{ row: obs({ source_tier: null }) }]);
  assert.ok(unrated.ok && unrated.admissibility === "display_only", "an unrated source never serves a filing");
  const tier3 = run("carbon_price_eur_t", [{ row: obs({ source_tier: 3 }) }]);
  assert.ok(tier3.ok && tier3.admissibility === "display_only", "below the filing rating");
  assert.match(refusal(run("carbon_price_eur_t", [])), /no observation supplied/);
  assert.match(refusal(run("carbon_price_eur_t", [{ row: obs({ unit: "USD/t", currency: "USD" }) }])), /is in "USD\/t", not EUR\/tCO2 or EUR\/tCO2e or EUR\/t/);
  assert.match(refusal(run("carbon_price_eur_t", [{ row: obs({ currency: "GBP" }) }])), /is in GBP, not EUR/);
  assert.match(refusal(run("carbon_price_eur_t", [{ row: obs({ value_numeric: 0 }) }])), /no positive number/);
  const payload = run("feu_payload_tonnes", [{ row: obs({ series_key: "feu-payload:d", value_numeric: 14, unit: "t/FEU", currency: null }) }]);
  assert.ok(payload.ok);
  assert.deepEqual([payload.value, payload.unit, payload.currency], [14, "t/FEU", null]);
  assert.match(refusal(run("feu_payload_tonnes", [{ row: obs({ unit: "EUR/t" }) }])), /not t\/FEU or tonnes\/FEU/);
});

test("the distance is the great circle between the two ports, calculation-grade and labelled not routed; an end with no position refuses and names its code", () => {
  const quarter = run("corridor_distance_km", [{ pk: "AAAAA", row: { lat: 0, lon: 0 } }, { pk: "BBBBB", row: { lat: 0, lon: 90 } }]);
  assert.ok(quarter.ok);
  assert.equal(quarter.value, Math.round(((Math.PI / 2) * 6371.0088) * 10) / 10, "a quarter of the equator");
  assert.deepEqual([quarter.unit, quarter.admissibility, quarter.derivation, quarter.basis], ["km", "calculation_ok", "calculated", "great-circle, not routed: AAAAA to BBBBB"]);
  const pole = run("corridor_distance_km", [{ pk: "N", row: { lat: 90, lon: 0 } }, { pk: "S", row: { lat: -90, lon: 0 } }]);
  assert.ok(pole.ok && Math.abs(pole.value! - Math.PI * 6371.0088) < 0.1, "pole to pole is half the circumference");
  assert.equal(refusal(run("corridor_distance_km", [{ pk: "ESBCN", row: null }, { pk: "NLRTM", row: { lat: 51.92, lon: 4.48 } }])), "no port position recorded for ESBCN");
  assert.equal(refusal(run("corridor_distance_km", [{ pk: "ESBCN", row: null }, { pk: "TWKEL", row: null }])), "no port position recorded for ESBCN, TWKEL");
  assert.match(refusal(run("corridor_distance_km", [{ pk: "ONE", row: { lat: 0, lon: 0 } }])), /origin and a destination/);
});

const dv = (method_id: string, value: number, admissibility: string, over: Record<string, unknown> = {}) => ({ row: { method_id, value, admissibility, unit: null, currency: null, base_confidence: 0.9, ...over } });
const four = (levels: [string, string, string, string]) => [
  dv("carbon_price_eur_t", 70, levels[0], { unit: "EUR/tCO2e", currency: "EUR" }),
  dv("corridor_distance_km", 9000, levels[1], { unit: "km" }),
  dv("feu_payload_tonnes", 14, levels[2], { unit: "t/FEU", base_confidence: 0.95 }),
  dv("carbon_intensity_tkm", 16, levels[3], { unit: "gCO2e/tonne-km" }),
];

test("the cost is distance x intensity x payload x price, statutory-grade only when every input is filing-grade, display-grade otherwise", () => {
  const filing = run("carbon_cost_per_feu", four(["filing_ok", "filing_ok", "filing_ok", "filing_ok"]));
  assert.ok(filing.ok);
  assert.ok(Math.abs(filing.value! - 9000 * (16 / 1e6) * 14 * 70) < 1e-9);
  assert.deepEqual([filing.admissibility, filing.derivation, filing.lifecycle, filing.currency, filing.unit, filing.confidence], ["filing_ok", "calculated", "verified", "EUR", "EUR/FEU", 0.9]);
  for (let i = 0; i < 4; i += 1) {
    const levels = ["filing_ok", "filing_ok", "filing_ok", "filing_ok"] as [string, string, string, string];
    levels[i] = "calculation_ok";
    const cost = run("carbon_cost_per_feu", four(levels));
    assert.ok(cost.ok);
    assert.deepEqual([cost.admissibility, cost.derivation], ["display_only", "estimated"], `one input below filing makes the cost display-grade (input ${i})`);
  }
});

test("the cost refuses with the missing input and never computes around it; an intensity in another unit is refused", () => {
  const all = four(["filing_ok", "filing_ok", "filing_ok", "filing_ok"]);
  for (let i = 0; i < 4; i += 1) assert.match(refusal(run("carbon_cost_per_feu", all.filter((_, j) => j !== i))), /needs the price, the distance, the payload and the intensity/);
  assert.match(refusal(run("carbon_cost_per_feu", [...all.slice(0, 3), dv("carbon_intensity_tkm", 16, "filing_ok", { unit: "kgCO2e/tonne-km" })])), /not gCO2e\/tonne-km/);
  assert.match(refusal(run("carbon_cost_per_feu", [dv("carbon_price_eur_t", Number.NaN, "filing_ok"), ...all.slice(1)])), /holds no number/);
});
