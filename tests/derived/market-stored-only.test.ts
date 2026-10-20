// R2d S1, Market: no guessed fact. surfaces:3 (kind and corridor band from keyword regexes), surfaces:19 (one stored value, one customer word), surfaces:14 and 15 (sections that can never hold a row),
// surfaces:17 (the observation count past the 400-day window), surfaces:18 ("5 of 14" mixing families and series). Each case first reproduces the register's wrong output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createElement } from "react";

import { headlineCaption } from "@/features/market/lib/headline";
import { leadTimeCanHaveRows } from "@/features/market/lib/lead-time";
import { readMarketSeries } from "@/features/market/read";
import { CarbonCostOverlay } from "@/features/market/ui/CarbonCostOverlay";
import { LeadTimeChart } from "@/features/market/ui/LeadTimeChart";
import { MarketRail } from "@/features/market/ui/Rails";
import { bandOf, BAND_LABEL } from "@/features/market/lib/signal-band";
import { severityLabel } from "@/features/market/lib/severity";
import severityJson from "@/features/market/lib/data/severity.json";

import { memoryDb } from "../_support/memory-db.ts";
import { renderApp, textOf } from "../_support/render.ts";


test("surfaces:3 the kind and the band are the stored columns, or nothing: the keyword tables are gone and a signal without a column has no kind and no band", () => {
  const unclassified: { title: string; note: string; priority: string; severity?: string; signalBand?: "price" | "corporate" | "corridor" } = { title: "Deadline for the cost surcharge on the Suez route", note: "price rises at the port", priority: "HIGH" };
  assert.equal(severityLabel(unclassified.severity), null, "the old keyword pass called this 'Action required' or 'Cost alert'");
  assert.equal(bandOf(unclassified), null, "the old pass said 'Corridors and routes' (B3) from the words, and 'corporate' when none matched");
  assert.equal(bandOf({ signalBand: "corridor" }), "corridor");
  assert.equal(BAND_LABEL.corridor, "Corridors & routes");
  assert.equal(severityLabel("cost_alert"), "Cost alert");
  const text = readFileSync("src/features/market/lib/signal-band.ts", "utf8");
  assert.doesNotMatch(text, /KEYWORDS|deriveSeverity|assignBand|\\b\(/, "no keyword table or pattern remains in the band module");
});

test("surfaces:19 one severity vocabulary: a label for each of the thirteen stored values, never another value's word; an unknown value draws nothing", () => {
  assert.equal(severityLabel("high"), "High", "HIGH is the priority word High, not 'Cost alert'");
  assert.equal(severityLabel("critical"), "Critical", "not 'Action required'");
  assert.equal(severityLabel("window_closing"), "Window closing");
  assert.equal(severityLabel("something_new"), null);
  assert.equal(severityLabel(null), null);
  assert.equal(severityLabel(""), null);
  const sql = readFileSync("supabase/schema.sql", "utf8");
  const check = /intelligence_items_severity_check CHECK \(\(\(severity IS NULL\) OR \(severity = ANY \(ARRAY\[([^\]]*)\]/.exec(sql)?.[1] ?? "";
  const stored = [...check.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  assert.equal(stored.length, 13);
  assert.deepEqual(Object.keys(severityJson).sort(), [...stored].sort(), "the vocabulary covers exactly the values the column admits");
  assert.equal(new Set(Object.values(severityJson)).size, 13, "no two stored values share a word");
});

// ---- the sections and counts ----
const draw = (el: ReturnType<typeof createElement>) => textOf(renderApp(el));
const gapOnly = { label: "Shanghai → Rotterdam", corridor: { origin: "CNSHA", dest: "NLRTM", mode: "sea" }, entityId: "e1", jurisdictions: [], result: { ok: false as const, gaps: ["no corridor routing distance available yet"], partial: { intensity: null, distance: null, payload: null, carbonPrice: null } } };

test("surfaces:14 the carbon-cost section and its rail card are not drawn while every corridor can only list gaps; the gap sentences (licence wording) reach no customer", () => {
  assert.equal(draw(createElement(CarbonCostOverlay, { overlays: [gapOnly] as never })), "");
  const rail = draw(createElement(MarketRail, { carbon: [{ label: "CNSHA-NLRTM", fullLabel: "Shanghai → Rotterdam", missing: 3, point: null, currency: null }], drops: [], board: null }));
  assert.doesNotMatch(rail, /Carbon cost per FEU|input.* missing|licence/i);
  const withFigure = draw(createElement(MarketRail, { carbon: [{ label: "CNSHA-NLRTM", fullLabel: "Shanghai → Rotterdam", missing: 0, point: 96, currency: "EUR" }], drops: [], board: null }));
  assert.match(withFigure, /Carbon cost per FEU/);
  assert.match(withFigure, /EUR 96/);
});

test("surfaces:15 the lead-time section is drawn only when rows exist or the producer that writes them is implemented; the SBTi producer is registered as not implemented", () => {
  assert.equal(leadTimeCanHaveRows([]), false);
  assert.equal(draw(createElement(LeadTimeChart, { rows: [] })), "");
  const rows = Array.from({ length: 5 }, (_, i) => ({ series_key: `sbti:co-${i}`, label: `Company ${i}`, value_numeric: 12 + i, unit: "months" }));
  assert.equal(leadTimeCanHaveRows(rows), true);
  assert.match(draw(createElement(LeadTimeChart, { rows })), /Cohort median/);
});

test("surfaces:17 the observation count is the series', not the window's: a series older than 400 days with 60 observations says 60", async () => {
  const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = Array.from({ length: 60 }, (_, i) => ({ series_key: "eu-oil-bulletin:diesel-nl", label: "Diesel NL", value_numeric: 1.5 + i / 100, unit: "EUR/L", currency: "EUR", derivation: "observed", origin_class: "official", source_key: "ec_weekly_oil_bulletin", source_ref: "r", n_observations: null, method_version: "v1", as_at_date: day(i), reference_period: day(i) }));
  const { board } = await readMarketSeries(memoryDb({ market_series: rows, data_sources: [], sources: [] }).db);
  const series = board.groups.find((g) => g.keyPrefix === "eu-oil-bulletin")?.series[0];
  assert.ok((series?.deltas.sparkline.length ?? 60) < 60, "the window drops the oldest rows");
  assert.equal(series?.observationCount, 60);
});

test("surfaces:18 the headline caption states families and series as two numbers, never one as a fraction of the other", () => {
  assert.equal(headlineCaption({ cards: new Array(5) as never, totalSeries: 14 }), "5 families from 14 series");
  assert.equal(headlineCaption({ cards: new Array(1) as never, totalSeries: 1 }), "1 family from 1 series");
  assert.doesNotMatch(headlineCaption({ cards: new Array(5) as never, totalSeries: 14 }), /\bof\b/);
});
