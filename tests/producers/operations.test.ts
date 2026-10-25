// The operations producers: the UKPN release mapping and gates, the NESO blocks, the regional envelope (INV-244) with its three dataset specs, the cited state-cost
// facts with their entity authorship, the operator rows contract through the one producer, and the two calculators.
import assert from "node:assert/strict";
import { test } from "node:test";

import { entityId } from "@/core/entities";
import { runProducer, type ProducerSpec } from "@/core/producers/runner";
import { auxiliaryEnergy } from "@/features/operations/calc/auxiliary-energy";
import { gridQueueGate } from "@/features/operations/calc/grid-queue";
import { nesoCarbonIntensity } from "@/features/operations/producers/neso-carbon-intensity";
import { auxiliaryEnergyRows, indexationRows } from "@/features/operations/producers/operator-rows";
import { blsOews, buildEnvelopeRow, eurostatElectricity, eurostatLabourCost, latestPerNaturalKey } from "@/features/operations/producers/regional-envelope";
import { stateCostFacts } from "@/features/operations/producers/state-cost-facts";
import { ukpnHeatmap } from "@/features/operations/producers/ukpn-heatmap";

import { memoryDb } from "../_support/memory-db.ts";

import { makeDeps, NOW, parseDoc } from "./support.ts";

const ON = (spec: ProducerSpec): ProducerSpec => ({ ...spec, enabled: true });

// ---- UKPN ----
const GB_JURISDICTION_ID = entityId("jurisdiction", "GB");
const LICENCE = "CC BY 4.0";
const LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";
const PORTAL = "https://ukpowernetworks.opendatasoft.com";
const sub = (o: object) => ({ mRID: "S1", name: "Alpha", demandFirmCapacity: 10, demandAvailableCapacity: 4.5, demandConstraint: "AMBER", demandConstraintLimitingFactor: " thermal ", ...o });
const release = (subs: object[], over: object = {}) => ({ identifier: "ukpn-capacity-heatmap", rights: LICENCE_URL, publisher: "UK Power Networks", coverage: "Eastern Power Networks", issued: "2026-09-30T00:00:00", Substations: subs, ...over });
const meta = (over: object = {}) => ({ dataset_id: "ukpn-capacity-heatmap", metas: { default: { license: LICENCE, publisher: "UKPN" } }, attachments: [{ mimetype: "application/json", title: "LTDS_Heatmap_EPN_2026.json", url: "https://ukpowernetworks.opendatasoft.com/api/files/a.json" }, { mimetype: "application/json", title: "LTDS_Heatmap_EPN_2026.json", url: "http://ukpowernetworks.opendatasoft.com/a.json" }, { mimetype: "application/json", title: "LTDS_Heatmap_EPN_2026.json", url: "https://evil.example/a.json" }, { mimetype: "text/csv", title: "other.csv", url: "https://ukpowernetworks.opendatasoft.com/o.csv" }], ...over });
const bundle = (subs: object[], fileOver: object = {}, m: object = meta()) => JSON.stringify({ meta: m, files: [{ title: "LTDS_Heatmap_EPN_2026.json", json: release(subs, fileOver) }] });

test("UKPN golden: release mapping to rows (queue months NULL with obs_status L, never M), duplicates and bad numbers skipped by name", async () => {
  const m = await parseDoc(ukpnHeatmap, { text: bundle([sub({}), sub({ name: "Dup" }), sub({ mRID: "S2", demandFirmCapacity: "x" }), sub({ mRID: "S3", demandConstraint: "BLUE" }), sub({ mRID: "S4", demandAvailableCapacity: -2 }), { name: "no id" }]) });
  assert.equal(m.rows.length, 2);
  assert.deepEqual(m.rows[0], { jurisdiction_id: GB_JURISDICTION_ID, dso_name: "UK Power Networks, Eastern Power Networks", capacity_band_mw: null, queue_months_p50: null, queue_months_p90: null, as_of: "2026-09-30", obs_status: "L", substation_ref: "S1", substation_name: "Alpha", demand_firm_mw: 10, demand_available_mw: 4.5, demand_constraint: "AMBER", demand_constraint_limiting_factor: "thermal", source_id: null, origin_class: "official", derivation: "observed", confidence_admiralty: null });
  assert.equal(m.warnings.length, 4);
  assert.match(m.warnings.join("|"), /duplicate mRID S1/);
  assert.match(m.warnings.join("|"), /demandConstraint "BLUE"/);
  await assert.rejects(parseDoc(ukpnHeatmap, { text: bundle([sub({})], { rights: "https://example.com/x" }) }), /refusing/);
  await assert.rejects(parseDoc(ukpnHeatmap, { text: bundle([sub({})], { issued: "yesterday" }) }), /ISO date/);
  await assert.rejects(parseDoc(ukpnHeatmap, { text: bundle([sub({})], { identifier: "other" }) }), /identifier/);
  assert.equal(GB_JURISDICTION_ID, entityId("jurisdiction", "GB"));
});

test("UKPN: only https attachments on the portal host with a heatmap title are used; a wrong catalogue licence refuses the data", async () => {
  const heatmap = `${PORTAL}/api/files/a.json`;
  const page = makeDeps({ noDb: true, routes: { [`${PORTAL}/api/explore/v2.1/catalog/datasets/ukpn-capacity-heatmap`]: JSON.stringify(meta()), [heatmap]: JSON.stringify(release([sub({})])) } });
  await runProducer(page.deps, { spec: ukpnHeatmap });
  assert.deepEqual(page.calls.map((c) => c.url), [`${PORTAL}/api/explore/v2.1/catalog/datasets/ukpn-capacity-heatmap`, heatmap], "only the https attachment on the portal host with a heatmap title is fetched");
  await assert.rejects(parseDoc(ukpnHeatmap, { text: bundle([sub({})], {}, meta({ metas: { default: { license: "All rights reserved" } } })) }), /refusing to use the data/);
  await assert.rejects(parseDoc(ukpnHeatmap, { text: bundle([sub({})], {}, meta({ attachments: [] })) }), /no heatmap JSON attachment/);
  const bad = await runProducer(makeDeps({ noDb: true }).deps, { spec: ukpnHeatmap, text: bundle([sub({})], {}, meta({ metas: { default: { license: "x" } } })) });
  assert.equal(bad.outcome, "failed");
  assert.match(bad.notes[0] as string, /structure/);
  const ok = await runProducer(makeDeps({ noDb: true }).deps, { spec: ukpnHeatmap, text: bundle([sub({})]) });
  assert.equal(ok.counts.parsed, 1);
});

test("UKPN apply: the publisher is registered at its class tier and must be active, the GB entity must exist (never minted), then rows are keyed and a re-run patches nothing", async () => {
  const noGb = memoryDb({});
  const refused = await runProducer(makeDeps({ db: noGb, env: { OPERATIONS_PRODUCER_UKPN_HEATMAP_ENABLED: "1" } }).deps, { spec: ON(ukpnHeatmap), dry: false, text: bundle([sub({})]) });
  assert.equal(refused.outcome, "failed");
  assert.match(refused.notes.join(" "), /not in entities; the spine is seeded elsewhere/);
  assert.equal(noGb.tables.grid_connection_queues, undefined);
  const db = memoryDb({ entities: [{ entity_id: GB_JURISDICTION_ID, kind: "jurisdiction" }] });
  const d = makeDeps({ db, env: { OPERATIONS_PRODUCER_UKPN_HEATMAP_ENABLED: "1" } });
  const r = await runProducer(d.deps, { spec: ON(ukpnHeatmap), dry: false, text: bundle([sub({}), sub({ mRID: "S9", name: "Nine" })]) });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.created, 2);
  const srcId = db.tables.sources?.[0]?.id;
  assert.ok(srcId);
  assert.ok((db.tables.grid_connection_queues ?? []).every((x) => x.source_id === srcId));
  const again = await runProducer(d.deps, { spec: ON(ukpnHeatmap), dry: false, text: bundle([sub({}), sub({ mRID: "S9", name: "Nine" })]) });
  assert.equal((again.counts.created ?? 0) + (again.counts.updated ?? 0), 0);
  const changed = await runProducer(d.deps, { spec: ON(ukpnHeatmap), dry: false, text: bundle([sub({ demandAvailableCapacity: 1 })]) });
  assert.equal(changed.counts.updated, 1);
  db.tables.sources![0]!.status = "inactive";
  const inactive = await runProducer(d.deps, { spec: ON(ukpnHeatmap), dry: false, text: bundle([sub({ mRID: "S10", name: "Ten" })]) });
  assert.equal(inactive.outcome, "failed");
  assert.match(inactive.notes.join(" "), /not active/);
});

// ---- NESO ----
const stamp = (d: string, h = "00") => `${d}T${h}:00Z`;
test("NESO golden: midnight-aligned daily blocks only; a misaligned block, a duplicate and a negative average are skipped by name; the window is the last 14 complete days", async () => {
  const doc = { data: [{ from: stamp("2026-10-01"), to: stamp("2026-10-02"), intensity: { average: 120 } }, { from: stamp("2026-10-01"), to: stamp("2026-10-02"), intensity: { average: 130 } }, { from: stamp("2026-10-02", "12"), to: stamp("2026-10-03", "12"), intensity: { average: 1 } }, { from: stamp("2026-10-03"), to: stamp("2026-10-04"), intensity: { average: -5 } }, { from: "bad", to: "x" }, { from: stamp("2026-10-04"), to: stamp("2026-10-05"), intensity: { average: 90.5 } }] };
  const parsed = await parseDoc(nesoCarbonIntensity, { text: JSON.stringify(doc) });
  const { warnings } = parsed;
  assert.equal(parsed.counts?.observations, 2, "two blocks are valid");
  assert.deepEqual(parsed.rows.map((o) => [o.reference_period, o.as_at_date, o.value_numeric]), [["2026-10-04", "2026-10-05", 90.5]], "the current-state table keeps the latest");
  assert.equal(warnings.length, 4);
  assert.match(warnings.join("|"), /not one midnight to midnight day/);
  assert.match(warnings.join("|"), /duplicate period/);
  await assert.rejects(parseDoc(nesoCarbonIntensity, { text: "{}" }), /no data array/);
  const fetched = makeDeps({ noDb: true, routes: { "https://api.carbonintensity.org.uk/": "{\"data\":[]}" } });
  await runProducer(fetched.deps, { spec: nesoCarbonIntensity });
  assert.equal(fetched.calls[0]?.url, "https://api.carbonintensity.org.uk/intensity/stats/2026-10-01T00:00Z/2026-10-14T23:59Z/24", "the last 14 complete days before the run's clock");
});

test("NESO apply (armed): the data_sources row and the UK region must exist; the source is rated and stamped; the current-state table keeps only the latest", async () => {
  const doc = JSON.stringify({ data: [{ from: stamp("2026-10-01"), to: stamp("2026-10-02"), intensity: { average: 120 } }, { from: stamp("2026-10-02"), to: stamp("2026-10-03"), intensity: { average: 100 } }] });
  const env = { REGIONAL_PRODUCER_NESO_CARBON_INTENSITY_ENABLED: "1" };
  const noDs = await runProducer(makeDeps({ db: memoryDb({ regions: [{ id: "r-uk", code: "UK" }] }), env }).deps, { spec: ON(nesoCarbonIntensity), dry: false, text: doc });
  assert.match(noDs.notes.join(" "), /no row for source_key neso_carbon_intensity/);
  const noRegion = await runProducer(makeDeps({ db: memoryDb({ data_sources: [{ source_key: "neso_carbon_intensity" }] }), env }).deps, { spec: ON(nesoCarbonIntensity), dry: false, text: doc });
  assert.match(noRegion.notes.join(" "), /region code UK not found/);
  const db = memoryDb({ data_sources: [{ source_key: "neso_carbon_intensity" }], regions: [{ id: "r-uk", code: "UK" }] });
  const r = await runProducer(makeDeps({ db, env }).deps, { spec: ON(nesoCarbonIntensity), dry: false, text: doc });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(db.tables.regional_data_facts?.length, 1);
  const row = db.tables.regional_data_facts?.[0];
  assert.deepEqual([row?.region_id, row?.dimension, row?.value_numeric, row?.reference_period, row?.value], ["r-uk", "grid_intensity", 100, "2026-10-02", "100 gCO2/kWh"]);
  assert.ok(row?.source_id);
});

// ---- regional envelope ----
test("INV-244: the envelope row derives its value text mechanically, only the latest observation per natural key is kept, and a malformed observation throws naming the field", () => {
  const obs = { region_code: "EU", dimension: "d", fact_label: "L", value_numeric: 1.5, unit: "EUR/kWh", derivation: "observed", origin_class: "official", source_key: "eurostat", source_ref: "r", method_version: "m", as_at_date: "2026-01-01", reference_period: "2026-S1" };
  assert.equal(buildEnvelopeRow(obs).value, "1.5 EUR/kWh");
  assert.throws(() => buildEnvelopeRow({ ...obs, unit: "" }), /missing required field "unit"/);
  const rows = latestPerNaturalKey([obs, { ...obs, as_at_date: "2026-07-01", reference_period: "2026-S2", value_numeric: 2 }, { ...obs, as_at_date: "2026-07-01", reference_period: "2026-S1", value_numeric: 3 }].map(buildEnvelopeRow));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.value_numeric, 2);
});

test("BLS golden: the series id is built from parts, the latest annual value per catalogued series wins, a rate-limited response fails with BLS's own message (B-0326), a dry run needs no credentials (bls defect)", async () => {
  const oewsId = (soc: string, datatype: string) => `OEUN${"0".repeat(7)}${"0".repeat(6)}${soc.replace("-", "")}${datatype}`;
  const ok = { status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: oewsId("53-3032", "13"), data: [{ period: "A01", year: "2023", value: "50000" }, { period: "A01", year: "2024", value: "52000" }, { period: "M01", year: "2025", value: "1" }] }, { seriesID: oewsId("53-3032", "08"), data: [{ period: "A01", year: "2024", value: "-" }] }, { seriesID: "OTHER", data: [] }] } };
  const obs = (await parseDoc(blsOews, { text: JSON.stringify(ok) })).rows;
  assert.equal(obs.length, 1);
  assert.deepEqual([obs[0]?.value_numeric, obs[0]?.reference_period, obs[0]?.as_at_date, obs[0]?.unit], [52000, "2024", "2024-05-01", "USD/year"]);
  await assert.rejects(parseDoc(blsOews, { text: JSON.stringify({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold reached"] }) }), /daily threshold reached/);
  const posted = makeDeps({ noDb: true, routes: { "https://api.bls.gov/": JSON.stringify(ok) } });
  await runProducer(posted.deps, { spec: blsOews });
  assert.ok((JSON.parse(posted.calls[0]?.init?.body ?? "{}") as { seriesid: string[] }).seriesid.includes(oewsId("53-3032", "13")), "the request names the series id built from its parts");
  const dry = await runProducer(makeDeps({ noDb: true }).deps, { spec: blsOews, text: JSON.stringify(ok) });
  assert.equal(dry.outcome, "ok");
  assert.equal(dry.counts.parsed, 1);
  const limited = await runProducer(makeDeps({ noDb: true }).deps, { spec: blsOews, text: JSON.stringify({ status: "REQUEST_NOT_PROCESSED", message: ["limit"] }) });
  assert.equal(limited.outcome, "failed");
});

const jsonStat = (dims: Record<string, string[]>, values: Record<string, number | null>, labels: Record<string, Record<string, string>> = {}) => ({
  id: Object.keys(dims), size: Object.values(dims).map((v) => v.length),
  dimension: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, { category: { index: Object.fromEntries(v.map((c, i) => [c, i])), ...(labels[k] ? { label: labels[k] } : {}) } }])), value: values,
});
test("Eurostat goldens: JSON-stat decoding, the labour-cost mean over the member states that answered (a failed state is excluded, never imputed), the electricity bands by half-year", async () => {
  const lc = (geo: string, vals: Record<string, number>) => jsonStat({ unit: ["EUR"], lcstruct: ["D1_D4_MD5"], nace_r2: ["B-N"], geo: [geo], time: ["2022", "2023"] }, vals);
  await assert.rejects(parseDoc(eurostatElectricity, { text: "{}" }), /not a JSON-stat/);
  const [fact] = (await parseDoc(eurostatLabourCost, { text: JSON.stringify({ DE: lc("DE", { 0: 40, 1: 42 }), NL: lc("NL", { 0: 30, 1: 34 }) }) })).rows;
  assert.deepEqual([fact?.value_numeric, fact?.n_observations, fact?.derivation, fact?.reference_period, fact?.unit], [38, 2, "calculated", "2023", "EUR/hour"]);
  assert.match(String(fact?.source_ref), /geo_mean_of=DE,NL;years=2023/);
  assert.deepEqual((await parseDoc(eurostatLabourCost, { text: "{}" })).rows, []);
  const d = makeDeps({ noDb: true, routes: { "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/lc_lci_lev?format=JSON&lang=EN&geo=DE": JSON.stringify(lc("DE", { 0: 40, 1: 42 })), "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/lc_lci_lev?format=JSON&lang=EN&geo=NL": JSON.stringify(lc("NL", { 0: 30, 1: 34 })) } });
  const r = await runProducer(d.deps, { spec: eurostatLabourCost });
  assert.equal(r.counts.parsed, 1, "four member states failed to answer and are excluded");
  const nrg = jsonStat({ unit: ["KWH"], currency: ["EUR"], tax: ["I_TAX"], nrg_cons: ["MWH2000-19999"], geo: ["EU27_2020"], time: ["2025-S1", "2025-S2", "2025-Q9"] }, { 0: 0.2, 1: 0.21, 2: 9 }, { nrg_cons: { "MWH2000-19999": "Band IC" } });
  const parsedNrg = await parseDoc(eurostatElectricity, { text: JSON.stringify(nrg) });
  const obs = parsedNrg.rows;
  assert.equal(parsedNrg.counts?.observations, 2, "the two valid half-years are observations; the invalid period is dropped");
  assert.deepEqual(obs.map((o) => [o.as_at_date, o.value_numeric, o.unit]), [["2025-07-01", 0.21, "EUR/kWh"]], "the current-state table keeps the latest half-year");
  assert.match(String(obs[0]?.fact_label), /Band IC/);
  const dry = await runProducer(makeDeps({ noDb: true }).deps, { spec: eurostatElectricity, text: JSON.stringify(nrg) });
  assert.equal(dry.counts.parsed, 1, "current-state: the latest half-year only");
});

test("INV-244: a region code absent from regions FAILS the run (never guessed); present codes become region_id rows keyed by the natural key; a re-run changes nothing", async () => {
  const nrg = JSON.stringify(jsonStat({ unit: ["KWH"], currency: ["EUR"], tax: ["I_TAX"], nrg_cons: ["B"], geo: ["EU27_2020"], time: ["2025-S1"] }, { 0: 0.2 }));
  const env = { REGIONAL_PRODUCER_EUROSTAT_NRG_PC_205_ENABLED: "1" };
  const none = await runProducer(makeDeps({ db: memoryDb({ regions: [{ id: "r1", code: "US" }] }), env }).deps, { spec: ON(eurostatElectricity), dry: false, text: nrg });
  assert.equal(none.outcome, "failed");
  assert.match(none.notes.join(" "), /region code\(s\) not found in the live regions table: EU/);
  const db = memoryDb({ regions: [{ id: "r-eu", code: "EU" }] });
  const d = makeDeps({ db, env });
  const r = await runProducer(d.deps, { spec: ON(eurostatElectricity), dry: false, text: nrg });
  assert.equal(r.counts.created, 1);
  assert.equal(db.tables.regional_data_facts?.[0]?.region_id, "r-eu");
  assert.equal("region_code" in (db.tables.regional_data_facts?.[0] ?? {}), false);
  assert.equal((await runProducer(d.deps, { spec: ON(eurostatElectricity), dry: false, text: nrg })).counts.unchanged, 1);
});

// ---- state cost facts ----
const cand = (o: object = {}) => ({ state_code: "CA", state_label: "California", region_code: "US-CA", dimension: "labor", fact_label: "Minimum wage", value: "16.50", unit: "USD/hour", source_url: "https://eur-lex.europa.eu/mw", source_name: "State labour department", span_text: "minimum wage is $16.50 per hour", ...o });
test("state cost facts: grounded verbatim before rated, refused by name otherwise; a write authors the state's jurisdiction entity, identifier and ref (rule 17); origin class from the tier", async () => {
  const routes = { "https://eur-lex.europa.eu/mw": "In 2026 the minimum wage is $16.50 per hour statewide." };
  const dry = await runProducer(makeDeps({ noDb: true, routes }).deps, { spec: stateCostFacts, text: JSON.stringify([cand(), cand({ fact_label: "Paraphrase", span_text: "pay floor of sixteen fifty" }), cand({ fact_label: "Gone", span_text: null }), cand({ fact_label: "Bad host", source_url: "https://www.mondaq.com/x", span_text: "minimum wage" })]) });
  assert.equal(dry.counts.parsed, 1);
  const t = dry.notes.join("|");
  assert.match(t, /refused_ungrounded: span_text is not a verbatim substring/);
  assert.match(t, /refused_ungrounded: no span_text supplied/);
  const db = memoryDb({ regions: [{ id: "r-ca", code: "US-CA" }] });
  const d = makeDeps({ db, routes, env: {} });
  const held = await runProducer(d.deps, { spec: { ...stateCostFacts, enabled: false }, dry: false, text: JSON.stringify([cand()]) });
  assert.match(held.notes[0] as string, /ENABLED constant is false/);
  const r = await runProducer(d.deps, { spec: ON(stateCostFacts), dry: false, text: JSON.stringify([cand()]) });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(db.tables.state_cost_facts?.length, 1);
  assert.equal(db.tables.state_cost_facts?.[0]?.region_id, "r-ca");
  assert.equal(db.tables.state_cost_facts?.[0]?.value_numeric, 16.5);
  assert.ok(db.tables.state_cost_facts?.[0]?.source_id);
  assert.equal(db.tables.state_cost_facts?.[0]?.origin_class, "official", "a government publisher's tier is an official origin");
  assert.equal(db.tables.entities?.[0]?.entity_id, entityId("jurisdiction", "CA"));
  assert.equal(db.tables.entity_refs?.[0]?.role, "jurisdiction");
  assert.equal(r.counts.refs_written, 1);
  const again = await runProducer(d.deps, { spec: ON(stateCostFacts), dry: false, text: JSON.stringify([cand()]) });
  assert.equal((again.counts.created ?? 0) + (again.counts.updated ?? 0), 0);
  assert.equal(again.counts.refs_written ?? 0, 0);
  const noRegion = await runProducer(makeDeps({ db: memoryDb({}), routes }).deps, { spec: ON(stateCostFacts), dry: false, text: JSON.stringify([cand()]) });
  assert.match(noRegion.notes.join(" "), /region code\(s\) not found/);
});

test("state cost facts: a span is grounded on the text layer of a published PDF rate schedule and on the visible text of a page whose table cells carry tags; a span in neither is refused", async () => {
  const content = "BT /F1 12 Tf 72 700 Td (Diesel 55.8 cents per gallon) Tj ET";
  const pdf = ["%PDF-1.4", "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj", "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj", "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj", `4 0 obj<</Length ${content.length}>>stream`, content, "endstream endobj", "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj", "trailer<</Root 1 0 R/Size 6>>", "%%EOF", ""].join(String.fromCharCode(10));
  const routes = {
    "https://eur-lex.europa.eu/rates.pdf": () => new Response(new TextEncoder().encode(pdf), { status: 200, headers: { "content-type": "application/pdf" } }),
    "https://eur-lex.europa.eu/rates.html": () => new Response("<table><tr><td>Diesel</td> <td>47 cents per gallon</td></tr></table>", { status: 200, headers: { "content-type": "text/html" } }),
  };
  const c = (o: object) => cand({ dimension: "operational_cost", fact_label: "Diesel tax", value: "0.558", unit: "USD per gallon", ...o });
  const r = await runProducer(makeDeps({ noDb: true, routes }).deps, { spec: stateCostFacts, text: JSON.stringify([
    c({ source_url: "https://eur-lex.europa.eu/rates.pdf", span_text: "Diesel 55.8 cents per gallon" }),
    c({ source_url: "https://eur-lex.europa.eu/rates.html", fact_label: "Diesel tax html", span_text: "Diesel 47 cents per gallon" }),
    c({ source_url: "https://eur-lex.europa.eu/rates.pdf", fact_label: "Not in the pdf", span_text: "Diesel 99 cents per gallon" }),
  ]) });
  assert.equal(r.counts.parsed, 2, r.notes.join("|"));
  assert.match(r.notes.join("|"), /Not in the pdf: refused_ungrounded/);
});

// ---- operator rows ----
test("operator rows: the org is stamped by the caller (never read from the CSV), a rejected row is named, an unknown entity reference is refused at apply, identical rows are not inserted twice", async () => {
  const csv = "load_type,kw_draw,duty_cycle,hours_typical,node_id,org_id\nreefer_genset,12,0.5,10,cl:node:known,evil-org\nreefer_genset,12,2,10,,\nreefer_genset,8,0.5,4,cl:node:unknown,\n";
  const noOrg = await runProducer(makeDeps({ noDb: true }).deps, { spec: auxiliaryEnergyRows, text: csv });
  assert.equal(noOrg.outcome, "failed");
  assert.match(noOrg.notes[0] as string, /orgId is required/);
  const dry = await runProducer(makeDeps({ noDb: true }).deps, { spec: auxiliaryEnergyRows, text: csv, orgId: "org-1" });
  assert.equal(dry.counts.parsed, 2);
  assert.equal(dry.counts.rejected, 1);
  assert.match(dry.notes.join("|"), /row 3: duty_cycle must be between 0 and 1/);
  const db = memoryDb({ entities: [{ entity_id: "cl:node:known" }] });
  const d = makeDeps({ db, env: { OPERATIONS_PRODUCER_AUX_ENERGY_ROWS_ENABLED: "1" } });
  const r = await runProducer(d.deps, { spec: ON(auxiliaryEnergyRows), dry: false, text: csv, orgId: "org-1" });
  assert.equal(r.outcome, "partial");
  assert.equal(r.counts.created, 1);
  assert.match(r.notes.join("|"), /row 4: node_id "cl:node:unknown" does not match any known entity/);
  assert.deepEqual([db.tables.auxiliary_energy_profiles?.[0]?.org_id, db.tables.auxiliary_energy_profiles?.[0]?.node_id], ["org-1", "cl:node:known"]);
  assert.equal((await runProducer(d.deps, { spec: ON(auxiliaryEnergyRows), dry: false, text: csv, orgId: "org-1" })).counts.created, 0);
  const gap = await runProducer(d.deps, { spec: ON(indexationRows), text: "", orgId: "org-1" });
  assert.equal(gap.counts.gap, 1);
});

// ---- calculators ----
test("calculators: auxiliary energy is kWh, then gCO2e only with a SOURCED intensity (never assumed), then a ratio only with a leg; the grid gate reads p90 and UNKNOWN is never CLEAR", () => {
  assert.equal(auxiliaryEnergy({ kwDraw: 10, dutyCycle: 1.5, hoursTypical: 8 }).kwh.label, "M", "a duty cycle above 1 is refused");
  assert.equal(auxiliaryEnergy({ kwDraw: 10, dutyCycle: 0.5, hoursTypical: 8, gridIntensityGco2ePerKwh: 100, legGco2e: 0 }).ratio.label, "M", "a ratio against a leg of zero is refused");
  const full = auxiliaryEnergy({ kwDraw: 10, dutyCycle: 0.5, hoursTypical: 8, gridIntensityGco2ePerKwh: 100, legGco2e: 2000 });
  assert.deepEqual([full.kwh.value, full.gco2e.value, full.ratio.value, "exceedsLeg" in full.ratio && full.ratio.exceedsLeg], [40, 4000, 2, true]);
  const noIntensity = auxiliaryEnergy({ kwDraw: 10, dutyCycle: 0.5, hoursTypical: 8 });
  assert.equal(noIntensity.kwh.value, 40);
  assert.equal(noIntensity.gco2e.label, "M");
  assert.equal(gridQueueGate({ queueMonthsP90: 30, horizonMonths: 24 }).value, "BLOCKED");
  assert.equal(gridQueueGate({ queueMonthsP90: 12, horizonMonths: 24 }).value, "CLEAR");
  assert.equal(gridQueueGate({ queueMonthsP90: null, horizonMonths: 24 }).value, "UNKNOWN");
  assert.equal(gridQueueGate({ queueMonthsP90: 1, horizonMonths: -1 }).label, "M");
  void NOW;
});
