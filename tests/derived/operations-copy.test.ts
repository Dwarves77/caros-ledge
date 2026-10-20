// R2d S1/S2/S5, Operations and the empties that blamed a missing primary source: surfaces:7 (an Absence reason that is a lie), surfaces:12 (freshness from a constant), surfaces:13 and 71 (build prose in customer cards),
// surfaces:16 (a six-state mean labelled EU), surfaces:32 (a failed roster read as an empty roster), surfaces:66 and 67 (database tokens and variable names). Each case first reproduces the register's wrong output.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { eurostatLabourCost } from "@/features/operations/producers/regional-envelope";
import { AUXILIARY_ENERGY_ASIDE, GRID_QUEUE_ASIDE } from "@/features/operations/model/spec09";
import { readOperationsPage } from "@/features/operations/read/operations-reads";
import { LabourChain } from "@/features/operations/ui/LabourChain";
import { AuxiliaryEnergyPanel, GridQueuePanel } from "@/features/operations/ui/Spec09Panels";
import { StatementsBlock } from "@/features/operations/ui/StatementsBlock";
import { ObligationsRailCard } from "@/features/regulations/rail";

import { memoryDb } from "../_support/memory-db.ts";
import { parseDoc } from "../producers/support.ts";
import { renderApp, textOf } from "../_support/render.ts";

const draw = (el: ReturnType<typeof createElement>) => textOf(renderApp(el));
const MISSING_SOURCE = /needs primary-source figure/;

test("surfaces:7 an empty list says what is true: nothing due in 30 days is not a missing primary-source figure", () => {
  const text = draw(createElement(ObligationsRailCard, { events: [], failed: false, nowIso: "2026-10-19T00:00:00Z" }));
  assert.doesNotMatch(text, MISSING_SOURCE);
  assert.match(text, /Nothing is due in the next 30 days/);
});

test("surfaces:7 and 66 a labour term held only per year says so (its cause), draws a dash and no primary-source reason, and a chain term names its source by name, never by the stored key", () => {
  const text = draw(createElement(LabourChain, { regionLabel: "US", facts: [{ factLabel: "US — Heavy truck drivers annual median wage (OEWS)", valueNumeric: 52000, unit: "USD/year", currency: "USD", sourceKey: "bls", sourceName: "US Bureau of Labor Statistics", referencePeriod: "2025" }] }));
  assert.doesNotMatch(text, MISSING_SOURCE);
  assert.doesNotMatch(text, /unnamed source|\bbls\b/);
  const hourly = draw(createElement(LabourChain, { regionLabel: "US", facts: [{ factLabel: "US — Heavy truck drivers hourly median wage (OEWS)", valueNumeric: 25, unit: "USD/hour", currency: "USD", sourceKey: "bls", sourceName: "US Bureau of Labor Statistics", referencePeriod: "2025" }] }));
  assert.match(hourly, /US Bureau of Labor Statistics · 2025/);
  assert.doesNotMatch(hourly, /\bbls\b/);
});

test("surfaces:7 a statement component whose source is unrated shows 'Source not rated', not a primary-source reason", () => {
  const text = draw(createElement(StatementsBlock, { droppedVerdicts: 0, statements: [{ dimension: "labor_markets", factLabel: "Wage", sentence: "Wages are held for two regions.", absence: null, components: [{ regionCode: "US", regionLabel: "US", valueText: "25 USD/hour", index: null, sourceTier: null, sourceName: null, sourceUrl: null, datasetRef: null, referencePeriod: null, statusFlag: null, originClass: null, asAtDate: null }] }] as never }));
  assert.doesNotMatch(text, MISSING_SOURCE);
});

test("surfaces:12 freshness is judged against the cadence the fact's producer registered; no cadence, no date, or an unregistered producer is unknown, and the constant 'annual' is gone", async () => {
  const region = "r1";
  const fact = (id: string, over: Record<string, unknown>) => ({ id, region_id: region, dimension: "labor_markets", fact_label: id, value: "1", status: null, trend: null, source_note: null, last_updated: "2025-05-01", value_numeric: 1, unit: "USD/hour", currency: "USD", derivation: "observed", origin_class: "official", source_key: "bls", source_ref: "x", n_observations: null, method_version: "bls-oews-parser@1", as_at_date: "2025-05-01", reference_period: "2025", ...over });
  const m = memoryDb({ regions: [{ id: region, code: "US", label: "US", display_order: 1, iso_codes: ["US"] }], region_dimension_coverage: [], state_cost_facts: [], intelligence_items: [], derived_values: [], regional_data_facts: [fact("annual-old", {}), fact("annual-fresh", { as_at_date: "2026-09-01", last_updated: "2026-09-01" }), fact("hourly-grid", { method_version: "neso-carbon-intensity-stats-parser@1", as_at_date: "2026-10-18", last_updated: "2026-10-18" }), fact("hourly-grid-old", { method_version: "neso-carbon-intensity-stats-parser@1", as_at_date: "2026-08-01", last_updated: "2026-08-01" }), fact("no-producer", { method_version: "manual@1" }), fact("no-date", { as_at_date: null, last_updated: null })] });
  (m.db as unknown as { rpc: unknown }).rpc = (name: string) => {
    const run = Promise.resolve({ data: name === "get_surface_counts" ? { total_items: 0 } : [], error: null });
    return Object.assign(run, { range: () => run });
  };
  const facts = (await readOperationsPage(m.db, "2026-10-19T00:00:00Z", null)).facts ?? [];
  const by = Object.fromEntries(facts.map((f) => [f.factLabel, f.freshness]));
  assert.equal(by["annual-old"], "ageing", "an annual fact from 2025-05 is past its period (a constant 'annual' judged every fact alike)");
  assert.equal(by["annual-fresh"], "current");
  assert.equal(by["hourly-grid"], "current");
  assert.equal(by["hourly-grid-old"], "frozen", "a daily fact from August is not 'current for a year'");
  assert.equal(by["no-producer"], "unknown");
  assert.equal(by["no-date"], "unknown");
});

test("surfaces:16 the labour-cost fact names the member states averaged, so a six-state mean is never read as the EU and a changed composition is a different fact", async () => {
  const aggregateLcLciLevForRegion = async (byGeo: Record<string, unknown>) => (await parseDoc(eurostatLabourCost, { text: JSON.stringify(byGeo) })).rows;
  const js = (v: number, geo: string) => ({ id: ["geo", "time", "unit"], size: [1, 1, 1], dimension: { geo: { category: { index: { [geo]: 0 } } }, time: { category: { index: { "2024": 0 } } }, unit: { category: { index: { EUR: 0 } } } }, value: { "0": v } });
  const six = await aggregateLcLciLevForRegion(Object.fromEntries(["DE", "NL", "BE", "FR", "IT", "ES"].map((g, i) => [g, js(30 + i, g)])));
  assert.match(String(six[0]?.fact_label), /unweighted mean of 6 member states: BE, DE, ES, FR, IT, NL/);
  const five = await aggregateLcLciLevForRegion(Object.fromEntries(["DE", "NL", "BE", "FR", "IT"].map((g, i) => [g, js(30 + i, g)])));
  assert.match(String(five[0]?.fact_label), /unweighted mean of 5 member states: BE, DE, FR, IT, NL/);
  assert.notEqual(six[0]?.fact_label, five[0]?.fact_label, "a state that failed to answer makes a different fact, not a quietly different mean under the same label");
});

test("surfaces:67, 71 and 13 no variable name, no design note and no roadmap sentence reaches the customer in the profile panels", () => {
  const aux = draw(createElement(AuxiliaryEnergyPanel, { rows: [{ profile_id: "p", load_type: "cold_room", kw_draw: Number.NaN, duty_cycle: 0.5, hours_typical: 8, setpoint_c: 4, setpoint_rh_pct: null, grid_intensity_source: null }], intensity: null, retryHref: "/operations/x" }));
  assert.doesNotMatch(aux, /kwDraw|finite number|needs /);
  const grid = draw(createElement(GridQueuePanel, { rows: [{ queue_id: "q", dso_name: "UKPN", capacity_band_mw: "10-50", queue_months_p50: null, queue_months_p90: null, as_of: "2026-09-01", substation_name: null, demand_firm_mw: null, demand_available_mw: null, demand_constraint: null, demand_constraint_limiting_factor: null }], retryHref: "/operations/x" }));
  assert.doesNotMatch(grid, /needs |a gate, not a cost line/);
  assert.match(GRID_QUEUE_ASIDE, /assumed 24-month planning horizon/);
  assert.doesNotMatch(AUXILIARY_ENERGY_ASIDE, /per-tonne-km factor|never/);
});
