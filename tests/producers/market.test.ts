// The market producers: parser goldens against recorded shapes, the edge-authorship downstream (INV-045), the licence block, the EEA stream and Range read, the cited
// rows-file driver, published price statistics (INV-047), and the spec 09 calculators.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMethodRegistry, registerMarketMethods } from "@/core/propagation";
import { runProducer, type ProducerSpec } from "@/core/producers/runner";
import { applyFuelBurnMultiplier, compoundingChain } from "@/features/market/calc/reroute";
import { tcoCrossoverBand } from "@/features/market/calc/oem-payload";
import { carrierEtsSurcharge } from "@/features/market/producers/carrier-ets-surcharge";
import { ecbFx } from "@/features/market/producers/ecb-fx";
import { eiaPetroleumSpot } from "@/features/market/producers/eia-petroleum-spot";
import { euOilBulletin } from "@/features/market/producers/eu-oil-bulletin";
import { type MarketSeriesDeps, type SeriesRowLite } from "@/features/market/producers/market-series-delta";
import { publishedPriceStatistics, ratifySeriesItemMap } from "@/features/market/producers/published-price-statistics";
import { gridQueueRows, oemRoadmapRows, rerouteRows } from "@/features/market/producers/rows-file-producers";
import { sbtiTargets } from "@/features/market/producers/sbti-targets";
import { readSheet } from "@/core/producers/xlsx";

import { installPropagationRpcs } from "../_support/memdb.ts";
import { memoryDb } from "../_support/memory-db.ts";
import { SEEDED_SERIES } from "../market/series-rows.ts";

import { makeDeps, NOW, parseDoc, xlsx } from "./support.ts";

const ON = (spec: ProducerSpec): ProducerSpec => ({ ...spec, enabled: true });
const day = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;

// ---- ECB ----
const ECB = `<?xml version='1.0' encoding='UTF-8'?><gesmes:Envelope xmlns:gesmes='http://www.gesmes.org/xml/2002-08-01' xmlns='http://www.ecb.int/vocabulary/2002-08-01/eurofxref'><gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender><Cube><Cube time='2026-10-14'><Cube currency='USD' rate='1.0900'/><Cube rate='0.8700' currency='GBP'/><Cube currency='USD' rate='9.9'/><Cube currency='CHF' rate='0.95'/><Cube currency="JPY" rate="-3"/></Cube></Cube></gesmes:Envelope>`;

test("ECB golden (run 22's regression): a single-quoted document with attributes in either order parses; duplicates, an unknown currency and a bad rate are each skipped by name", async () => {
  const parseEcbFxXml = (text: string, meta?: object) => parseDoc(ecbFx, { text, ...(meta ? { meta } : {}) });
  const { rows, warnings } = await parseEcbFxXml(ECB);
  assert.deepEqual(rows.map((r) => [r.series_key, r.value_numeric, r.unit, r.reference_period]), [["ecb-fx:eur-usd", 1.09, "USD/EUR", "2026-10-14"], ["ecb-fx:eur-gbp", 0.87, "GBP/EUR", "2026-10-14"]]);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join("|"), /duplicate <Cube currency="USD">/);
  assert.match(warnings.join("|"), /"CHF" is not in this lane's closed vocabulary/);
  assert.match(warnings.join("|"), /bad rate "-3"/);
  assert.match((await parseEcbFxXml("<x/>")).warnings[0] as string, /no <Cube time/);
  assert.match((await parseEcbFxXml(ECB.replace("<Cube time='2026-10-14'>", "<Cube time='2026-10-14'><Cube time='2026-10-13'>"))).warnings[0] as string, /expected exactly one/);
  assert.match((await parseEcbFxXml(ECB.replace("European Central Bank", "Someone Else"))).warnings[0] as string, /sender/);
  assert.match((await parseEcbFxXml("abc", { status: 200, contentType: "text/xml" })).warnings.join("|"), /evidence: HTTP 200.*3 byte/);
});

const mkMarket = () => {
  const mem = memoryDb(
    { market_series: [{ id: "ms-prior", series_key: "ecb-fx:eur-usd", reference_period: "2026-10-07", as_at_date: "2026-10-07", value_numeric: 1.05, unit: "USD/EUR", currency: "USD", origin_class: "official" }] },
    { rpc: (name, args) => ((name === "register_derived_value" || name === "author_derived_value") ? (((mem.tables.derived_values ??= []).push({ value_id: "dv1", ...(args as object) }), ((args as { p_inputs: Array<{ table: string; pk: string }> }).p_inputs).forEach((i) => (mem.tables.derivation_edges ??= []).push({ from_table: i.table, from_pk: i.pk, to_table: "derived_values", to_value_id: "dv1" }))), { data: name === "author_derived_value" ? [{ value_id: "dv1", authored: true }] : "dv1" }) : {}) },
  );
  return mem;
};
const computeSeriesDeltas: MarketSeriesDeps["computeSeriesDeltas"] = (rows: SeriesRowLite[]) => {
  const pts = [...rows].map((r) => ({ r, d: String(r.reference_period) })).sort((a, b) => (a.d < b.d ? -1 : 1));
  const latest = pts[pts.length - 1];
  if (!latest) return {};
  const target = new Date(Date.parse(latest.d) - 7 * 86_400_000).toISOString().slice(0, 10);
  const prior = [...pts].reverse().find((p) => p.d <= target);
  const info = { date: latest.d, unit: latest.r.unit as string, currency: latest.r.currency as string };
  return prior ? { latest: info, delta1w: { value: Number(latest.r.value_numeric) - Number(prior.r.value_numeric), fromDate: prior.d } } : { latest: info, delta1w: { insufficientHistory: true } };
};
const withMarket = (deps: object, delta = computeSeriesDeltas) => {
  const registry = createMethodRegistry();
  registerMarketMethods(registry, { carbonIntensity: () => ({ ok: false, reason: "n/a" }), computeSeriesDeltas: delta as never });
  return Object.assign(deps, { market: { registry, computeSeriesDeltas: delta } });
};

test("INV-045/243: an apply writes only inside its own namespace, plans create or patch against (series_key, reference_period), then authors the delta edge in the same run", async () => {
  const mem = mkMarket();
  const d = makeDeps({ db: mem, env: { MARKET_PRODUCER_ECB_FX_ENABLED: "1" } });
  const r = await runProducer(withMarket(d.deps) as never, { spec: ON(ecbFx), dry: false, text: ECB });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.created, 2);
  assert.equal(r.counts.edges_authored, 1, "the USD series had a prior week; GBP has no history");
  assert.ok(mem.reads.some((x) => x.table === "market_series" && x.filters.some(([n, v]) => n === "like:series_key" && v === "ecb-fx:%")), "existing rows are read inside the producer's own key namespace");
  assert.equal(mem.tables.market_series?.length, 3);
  assert.equal(mem.tables.derivation_edges?.length, 2);
  // a re-run: nothing to create, no second edge
  const again = await runProducer(withMarket(d.deps) as never, { spec: ON(ecbFx), dry: false, text: ECB });
  assert.equal(again.counts.created, 0);
  assert.equal(again.counts.updated, 0);
});

// FIX-EDGES-1 (ruled run 40152169626): production held an observation of every ecb-fx series from 2026-08-28; the new write was 2026-10-14 against a clock of 2026-10-15. A one-week delta stands on a prior 5 to 9 days back
// (OPS-FIX-1 item 9), so a 47-day-old prior is no prior: the series is counted as insufficient history and the run is not failed. A prior a week back authors the edge.
const SPARSE_PRIORS = [
  { id: "ms-usd-aug", series_key: "ecb-fx:eur-usd", reference_period: "2026-08-28", as_at_date: "2026-08-28", value_numeric: 1.18, unit: "USD/EUR", currency: "USD", origin_class: "official" },
  { id: "ms-gbp-aug", series_key: "ecb-fx:eur-gbp", reference_period: "2026-08-28", as_at_date: "2026-08-28", value_numeric: 0.86, unit: "GBP/EUR", currency: "GBP", origin_class: "official" },
];
const WEEK_PRIORS = SPARSE_PRIORS.map((p) => ({ ...p, id: p.id.replace("aug", "wk"), reference_period: "2026-10-07", as_at_date: "2026-10-07" }));
const propagationDb = (rows: Record<string, unknown>[]) => {
  const mem = memoryDb({ market_series: rows.map((r) => ({ ...r })) });
  installPropagationRpcs(mem.mem);
  return mem;
};
const ecbRun = async (mem: ReturnType<typeof memoryDb>) => {
  const d = makeDeps({ db: mem, env: { MARKET_PRODUCER_ECB_FX_ENABLED: "1" } });
  return runProducer(withMarket(d.deps) as never, { spec: ON(ecbFx), dry: false, text: ECB });
};

test("OPS-FIX-1 item 9: a series whose prior observation is 47 days back has no one-week edge: it is counted as insufficient history, the run is not failed; a prior a week back authors the edge", async () => {
  const sparse = await ecbRun(propagationDb(SPARSE_PRIORS));
  assert.equal(sparse.outcome, "ok", sparse.notes.join("|"));
  assert.equal(sparse.counts.created, 2);
  assert.equal(sparse.counts.edges_authored, 0, "a 47-day-old prior is not a one-week prior");
  assert.equal(sparse.counts.edges_insufficient_history, 2);
  const mem = propagationDb(WEEK_PRIORS);
  const r = await ecbRun(mem);
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.edges_authored, 2, "USD and GBP each author a delta against their 2026-10-07 observation");
  const edges = mem.tables.derivation_edges ?? [];
  assert.equal(edges.length, 4, "two inputs (latest and prior) per authored value");
  assert.ok(WEEK_PRIORS.every((p) => edges.some((e) => e.from_pk === p.id)), "the week-old observation is an input of the edge");
});

test("FIX-EDGES-1: a re-run over rows that already exist writes 0 rows, and authors edges only where absent (INV-ARM-3)", async () => {
  // the state the failed production run left: the new rows landed, no edge was authored
  const landed = [
    { id: "ms-usd-oct", series_key: "ecb-fx:eur-usd", reference_period: "2026-10-14", as_at_date: "2026-10-14", value_numeric: 1.09, unit: "USD/EUR", currency: "USD", origin_class: "official", label: "EUR/USD — ECB euro foreign exchange reference rate (US dollar)", derivation: "observed", source_key: "ecb", source_ref: "ECB euro foreign exchange reference rates, 2026-10-14", n_observations: null, method_version: null },
    { id: "ms-gbp-oct", series_key: "ecb-fx:eur-gbp", reference_period: "2026-10-14", as_at_date: "2026-10-14", value_numeric: 0.87, unit: "GBP/EUR", currency: "GBP", origin_class: "official", label: "EUR/GBP — ECB euro foreign exchange reference rate (Pound sterling)", derivation: "observed", source_key: "ecb", source_ref: "ECB euro foreign exchange reference rates, 2026-10-14", n_observations: null, method_version: null },
  ];
  const mem = propagationDb([...WEEK_PRIORS, ...landed]);
  const first = await ecbRun(mem);
  assert.equal(first.outcome, "ok", first.notes.join("|"));
  assert.equal(first.counts.created, 0);
  assert.equal(first.counts.edges_authored, 2, "edges for rows that landed without them");
  const rows = mem.tables.market_series?.length;
  const edges = mem.tables.derivation_edges?.length;
  const again = await ecbRun(mem);
  assert.equal(again.outcome, "ok", again.notes.join("|"));
  assert.equal(again.counts.created, 0);
  assert.equal(again.counts.edges_authored, 0);
  assert.equal(again.counts.edges_already, 2, "present edges are not authored twice");
  assert.equal(mem.tables.market_series?.length, rows);
  assert.equal(mem.tables.derivation_edges?.length, edges);
});

test("INV-045: rows landed with authorship that accounted for no series, or refused one, fails the run CLOSED; an unwired downstream fails closed too; a first observation is counted, not failed", async () => {
  const noHistory = mkMarket();
  noHistory.tables.market_series = [];
  const d = makeDeps({ db: noHistory, env: { MARKET_PRODUCER_ECB_FX_ENABLED: "1" } });
  const r = await runProducer(withMarket(d.deps) as never, { spec: ON(ecbFx), dry: false, text: ECB });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.edges_insufficient_history, 2, "a first observation has no prior: stated as a count");
  const unwired = await runProducer(makeDeps({ db: mkMarket(), env: { MARKET_PRODUCER_ECB_FX_ENABLED: "1" } }).deps, { spec: ON(ecbFx), dry: false, text: ECB });
  assert.equal(unwired.outcome, "failed");
  assert.match(unwired.notes.join(" "), /not wired/);
});

test("INV-113: a registry entry's entity is stamped on created rows only; an ambient entity never reaches a run that declares none", async () => {
  const mem = mkMarket();
  const d = makeDeps({ db: mem, env: { MARKET_PRODUCER_ECB_FX_ENABLED: "1" } });
  await runProducer(withMarket(d.deps) as never, { spec: ON(ecbFx), dry: false, text: ECB, entityId: "cl:jurisdiction:9170a8b2fb3234ba" });
  const created = (mem.tables.market_series ?? []).filter((r) => r.id !== "ms-prior");
  assert.ok(created.length === 2 && created.every((r) => r.entity_id === "cl:jurisdiction:9170a8b2fb3234ba"));
  const plain = await runProducer(withMarket(makeDeps({ db: memoryDb({}), env: {} }).deps) as never, { spec: ecbFx, text: ECB });
  assert.equal(plain.outcome, "ok");
});

// ---- EIA ----
test("EIA golden: an unknown product, a duplicate (series, period), a missing unit and a bad period are each skipped by name; the key is read by env name and never logged", async () => {
  const row = (o: object) => ({ period: "2026-10-12", product: "EPCWTI", series: "RWTC", "area-name": "NA", units: "$/BBL", value: "71.4", ...o });
  const doc = { response: { total: 9, data: [row({}), row({}), row({ product: "EPXXX" }), row({ units: null, series: "R2" }), row({ period: "bad", series: "R3" }), row({ value: "n/a", series: "R4" })] } };
  const parseEia = (json: unknown) => parseDoc(eiaPetroleumSpot, { text: JSON.stringify(json) });
  const { rows, warnings, truncated } = await parseEia(doc);
  assert.deepEqual(rows.map((r) => [r.series_key, r.value_numeric, r.currency]), [["eia-v2:wti-crude-rwtc", 71.4, "USD"]]);
  assert.equal(warnings.length, 6, "five skipped rows and the partial-read warning");
  assert.match(warnings.join("|"), /unrecognised product "EPXXX"/);
  assert.match(warnings.join("|"), /duplicate \(series_key, period\)/);
  assert.match(warnings.join("|"), /missing "units"/);
  assert.equal(truncated, true, "the response reports 9 rows and carries 6: a partial read");
  assert.match((await parseEia({ error: "bad key" })).warnings[0] as string, /EIA API error/);
  const noKey = await runProducer(makeDeps({ noDb: true }).deps, { spec: eiaPetroleumSpot });
  assert.equal(noKey.outcome, "failed");
  assert.match(noKey.notes[0] as string, /no EIA_API_KEY/);
  const d = makeDeps({ noDb: true, env: { EIA_API_KEY: "SECRETKEY" }, routes: { "https://api.eia.gov/": () => new Response("down", { status: 500 }) } });
  const failed = await runProducer(d.deps, { spec: eiaPetroleumSpot });
  assert.equal(failed.outcome, "failed");
  assert.doesNotMatch(failed.notes.join(" "), /SECRETKEY/);
  assert.match(d.calls[0]?.url as string, /api_key=SECRETKEY/);
  const partial = await runProducer(makeDeps({ env: { MARKET_PRODUCER_EIA_V2_ENABLED: "1", EIA_API_KEY: "k" } }).deps, { spec: ON(eiaPetroleumSpot), dry: false, text: JSON.stringify(doc) });
  assert.match(partial.notes[0] as string, /byte-limited/, "a response whose total exceeds the rows returned is a partial read apply refuses");
});

// ---- EU Weekly Oil Bulletin ----
const bulletin = (over: { display?: string } = {}) =>
  xlsx("Prices wo taxes", [
    [null, "EU_price_wo_tax_euro95", "EU_price_wo_tax_diesel", "EU_price_wo_tax_mystery"],
    ["Date", over.display ?? "Euro-Super 95", "Automotive gas oil", "Mystery"],
    [null, null, null, null],
    [day("2026-10-12"), 1500.5, 1400, 9],
    [day("2026-10-05"), 1490, null, 9],
    ["footer text", null, null, null],
  ]);

test("the oil bulletin sheet golden: header resolution by machine id AND display text, the newest week by default, --since weeks, a missing price omitted not zero-filled", async () => {
  const all = await parseDoc(euOilBulletin, { bytes: bulletin() }, { input: { since: "2000-01-01" } });
  assert.match(all.warnings.join("|"), /unrecognised suffix "mystery"/);
  assert.deepEqual([...new Set(all.rows.map((r) => r.reference_period))].sort().reverse(), ["2026-10-12", "2026-10-05"]);
  const price = (week: string, slug: string) => all.rows.find((r) => r.reference_period === week && r.series_key === `eu-oil-bulletin:${slug}`)?.value_numeric;
  assert.deepEqual([price("2026-10-12", "eurosuper-95"), price("2026-10-12", "automotive-diesel")], [1500.5, 1400]);
  assert.match(all.warnings.join("|"), /no usable price/);
  assert.equal(price("2026-10-05", "automotive-diesel"), undefined);
  const newest = await parseDoc(euOilBulletin, { bytes: bulletin() });
  assert.deepEqual([...new Set(newest.rows.map((r) => r.reference_period))], ["2026-10-12"], "the newest week by default");
});

test("the oil bulletin: two independent header keys that disagree refuse the run rather than guess a column; the page link finder; the normalised CSV path", async () => {
  const bad = await runProducer(makeDeps({ noDb: true }).deps, { spec: euOilBulletin, bytes: bulletin({ display: "Automotive gas oil" }) });
  assert.equal(bad.outcome, "failed");
  assert.match(bad.notes[0] as string, /two independent keys disagree/);
  const ok = await runProducer(makeDeps({ noDb: true }).deps, { spec: euOilBulletin, bytes: bulletin() });
  assert.equal(ok.counts.parsed, 2, "newest week only: two priced products");
  const since = await runProducer(makeDeps({ noDb: true }).deps, { spec: euOilBulletin, bytes: bulletin(), since: "2026-10-01" });
  assert.equal(since.counts.parsed, 3);
  const badSince = await runProducer(makeDeps({ noDb: true, routes: {} }).deps, { spec: euOilBulletin, since: "next week" });
  assert.match(badSince.notes[0] as string, /not a well-formed YYYY-MM-DD/);
  const link = "https://energy.ec.europa.eu/document/download/x?filename=Weekly_Oil_Bulletin_Prices_History_4web.xlsx";
  const found = makeDeps({ noDb: true, routes: { "https://energy.ec.europa.eu/data-and-analysis/": '<a href="/document/download/x?filename=Weekly_Oil_Bulletin_Prices_History_4web.xlsx">h</a>', [link]: bulletin() } });
  await runProducer(found.deps, { spec: euOilBulletin });
  assert.equal(found.calls[1]?.url, link, "the page's link to the prices history is the file the producer reads");
  const csv = await parseDoc(euOilBulletin, { text: "week_ending;product;price_eur;n_member_states\n2026-10-12;eurosuper-95;1500.5;27\n2026-10-12;mystery;1;1\n12-10-2026;eurosuper-95;1;1\n2026-10-12;automotive-diesel;-4;1\n" });
  assert.equal(csv.rows.length, 1);
  assert.equal(csv.rows[0]?.n_observations, 27);
  assert.equal(csv.warnings.length, 3);
});

// ---- SBTi ----
const sbtiSheet = (omit?: string) => {
  const head = ["sector", "status", "action", "target", "base_year", "target_year", "date_published", "company_name"].filter((h) => h !== omit);
  const row = (v: Array<string | number>) => v.filter((_, i) => head.includes(["sector", "status", "action", "target", "base_year", "target_year", "date_published", "company_name"][i] as string));
  return xlsx("WebsiteData", [
    head,
    row(["Road Freight", "Other", "Targets set", "Near-term", 2019, 2030, 45658, "A"]),
    row(["Road Freight", "Other", "Targets set", "Near-term", 2020, 2030, 45700, "B"]),
    row(["Road Freight", "Other", "Targets set", "Near-term", 2021, 2031, 45680, "C"]),
    row(["Road Freight", "Other", "Targets set", "Net-zero", 2020, 2050, 45690, "D"]),
    row(["Road Freight", "Removed", "Removed", "Near-term", 2020, 2030, 45710, "E"]),
    row(["Road Freight", "Active", "x", "Near-term", 2020, 2030, 45710, "F"]),
    row(["Road Freight", "Other", "x", "Near-term", 2020, 1900, 45710, "G"]),
    row(["Ocean", "Other", "x", "Near-term", 2020, 2030, "no date", "H"]),
  ]);
};
test("SBTi golden: Excel serial dates, the header by NAME (a missing column refuses), lead time in months, survivorship counted, exclusions named", async () => {
  const r = await runProducer(makeDeps({ noDb: true }).deps, { spec: sbtiTargets, bytes: sbtiSheet() });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.sectors, 2);
  const { rows } = await sbtiTargets.parse({ bytes: sbtiSheet() }, {} as never);
  const byKey = new Map(rows.map((x) => [x.series_key, x]));
  assert.equal(byKey.get("sbti:near-term-lead-time-road-freight")?.value_numeric, 124);
  assert.equal(byKey.get("sbti:near-term-lead-time-road-freight")?.n_observations, 3);
  assert.equal(byKey.get("sbti:near-term-lead-time-road-freight")?.reference_period, "2025-02-12");
  assert.equal(byKey.get("sbti:net-zero-lead-time-road-freight")?.value_numeric, 360);
  assert.equal(byKey.get("sbti:commitment-removed-road-freight")?.value_numeric, 1);
  assert.equal(byKey.has("sbti:near-term-lead-time-ocean"), false, "an undated aggregate is skipped, not given today's date");
  const text = r.notes.join("|");
  assert.match(text, /status not Other\/Removed \("Active"\)/);
  assert.match(text, /target_year not after base_year|missing\/invalid target_year/);
  const missingCol = await runProducer(makeDeps({ noDb: true }).deps, { spec: sbtiTargets, bytes: sbtiSheet("target_year") });
  assert.equal(missingCol.outcome, "failed");
  assert.match(missingCol.notes[0] as string, /missing expected column\(s\): target_year/);
  const empty = await runProducer(makeDeps({ noDb: true }).deps, { spec: sbtiTargets, bytes: xlsx("WebsiteData", [["sector", "status", "action", "target", "base_year", "target_year", "date_published", "company_name"]]) });
  assert.equal(empty.counts.sectors ?? 0, 0, "a workbook with no company rows aggregates no sector");
});

test("INV-245: the SBTi producer is licence-blocked even when enabled, armed and credentialed; a dry run still reads and reports", async () => {
  const armed = makeDeps({ env: { MARKET_PRODUCER_SBTI_ENABLED: "1" } });
  const r = await runProducer(armed.deps, { spec: ON(sbtiTargets), dry: false, bytes: sbtiSheet() });
  assert.equal(r.outcome, "failed");
  assert.match(r.notes[0] as string, /licence block.*prohibited/);
  assert.equal(armed.mem.writes.length, 0);
  assert.equal((await runProducer(armed.deps, { spec: sbtiTargets, bytes: sbtiSheet() })).outcome, "ok");
});

test("the xlsx reader refuses a non-workbook and a missing sheet, naming the sheets present", () => {
  assert.throws(() => readSheet(Buffer.from("not a zip at all, definitely not"), "x"), /End Of Central Directory/);
  assert.throws(() => readSheet(bulletin(), "Nope"), /sheets present: Prices wo taxes/);
});

// ---- carrier ETS ----
test("carrier ETS: grounded before rated; an ungrounded and an unrated candidate are refused by name; one row per carrier per lane; the band is a real range, never a blend", async () => {
  const good = (carrier: string, v: number, url: string, over: object = {}) => ({ carrierName: carrier, tradeLane: "Lane A", currency: "USD", value: String(v), unit: "USD/FEU", effectivePeriod: "2026-10-01", surchargeType: "EU ETS", sourceUrl: url, span_text: `surcharge of USD ${v} per FEU`, ...over });
  const cands = [good("Carrier A", 210, "https://eur-lex.europa.eu/a"), good("Carrier B", 190, "https://eur-lex.europa.eu/b"), good("Carrier C", 230, "https://eur-lex.europa.eu/c", { span_text: "a paraphrase" }), good("Zxq D", 99, "https://www.mondaq.com/d")];
  const d = makeDeps({ noDb: true, routes: { "https://eur-lex.europa.eu/a": "The surcharge of USD 210 per FEU applies", "https://eur-lex.europa.eu/b": "The surcharge of USD 190 per FEU applies", "https://eur-lex.europa.eu/c": "The surcharge of USD 230 per FEU applies", "https://www.mondaq.com/": "The surcharge of USD 99 per FEU applies" } });
  const r = await runProducer(d.deps, { spec: carrierEtsSurcharge, text: JSON.stringify(cands) });
  assert.equal(r.counts.parsed, 2);
  assert.equal(r.counts.refused_ungrounded, 1);
  assert.equal(r.counts.refused_unrated_source, 1);
  assert.equal(r.counts.proxy_bands_built, 1);
  assert.match(r.notes.join("|"), /Carrier C\|Lane A\|2026-10-01: refused_ungrounded/);
  assert.match(r.notes.join("|"), /Zxq D\|Lane A\|2026-10-01: refused_unrated_source/);
  const rows = (await carrierEtsSurcharge.parse({ text: JSON.stringify(cands.slice(0, 2)) }, { get: async (u: string) => new Response(String(d.calls.length) + (u.endsWith("a") ? "The surcharge of USD 210 per FEU" : "The surcharge of USD 190 per FEU")), state: {}, deps: d.deps } as never)).rows;
  assert.deepEqual(rows.map((x) => x.series_key), ["carrier-ets:carrier-a-lane-a", "carrier-ets:carrier-b-lane-a"]);
  const ctx = { get: async (u: string) => new Response(u.endsWith("a") ? "The surcharge of USD 210 per FEU" : "The surcharge of USD 190 per FEU"), state: {}, deps: d.deps } as never;
  assert.equal((await carrierEtsSurcharge.parse({ text: JSON.stringify(cands.slice(0, 2)) }, ctx)).counts?.proxy_bands_built, 1, "two carriers in one period and one currency make one band");
  assert.equal((await carrierEtsSurcharge.parse({ text: JSON.stringify(cands.slice(0, 1)) }, ctx)).counts?.proxy_bands_built, 0, "one carrier is not a proxy");
  await assert.rejects(Promise.resolve(carrierEtsSurcharge.parse({ text: JSON.stringify([cands[0], { ...cands[1], currency: "EUR" }]) }, ctx)), /mixed currencies/);
  const held = await runProducer(makeDeps({}).deps, { spec: carrierEtsSurcharge, dry: false, text: JSON.stringify(cands) });
  assert.match(held.notes[0] as string, /ENABLED/);
});

// ---- cited rows files ----
const cite = { url: "https://eur-lex.europa.eu/doc", title: "A document", retrieved_at: "2026-10-01", quote: "q" };
const spine = (kind: string, names: string[]) => names.map((n, i) => ({ entity_id: `cl:${kind}:${String(i).padStart(16, "0")}`, canonical_name: n, kind }));
test("rows files: a citation is refused by name, an unclassifiable host is refused, an unknown manufacturer is never minted, a density needs its basis; accepted rows stay accepted", async () => {
  const db = memoryDb({ entities: spine("organisation", ["Acme Trucks"]) });
  const rows = [
    { manufacturer_name: "Acme Trucks", tech_category: "heavy_battery", commercial_stage: "pilot_demonstration", announced_at: "2026-09-01", target_year: 2027, citation: cite },
    { manufacturer_name: "Acme Trucks", tech_category: "heavy_battery", commercial_stage: "announced", announced_at: "2026-09-01" },
    { manufacturer_name: "Acme Trucks", tech_category: "heavy_battery", commercial_stage: "announced", announced_at: "2026-09-01", target_year: 2027, citation: { ...cite, url: "https://www.mondaq.com/x" } },
    { manufacturer_name: "Nobody Inc", tech_category: "heavy_battery", commercial_stage: "announced", announced_at: "2026-09-01", citation: cite },
    { manufacturer_name: "Acme Trucks", tech_category: "heavy_battery", commercial_stage: "announced", announced_at: "2026-09-01", energy_density_wh_kg: 150, citation: cite },
    { manufacturer_name: "Acme Trucks", tech_category: "flying_car", commercial_stage: "announced", announced_at: "2026-09-01", citation: cite },
    { manufacturer_name: "Acme Trucks", tech_category: "e_axle", commercial_stage: "announced", announced_at: "2026-09-01", citation: cite },
    { manufacturer_name: "Acme Trucks", tech_category: "e_axle", commercial_stage: "small_batch_fleet", announced_at: "2026-09-01", absent: { target_year: "the cited capture states no target year" }, citation: cite },
  ];
  const r = await runProducer(makeDeps({ db }).deps, { spec: oemRoadmapRows, text: JSON.stringify(rows) });
  assert.equal(r.counts.parsed, 2, "the row with a target year and the row that states its absence; the row with neither is refused (INV-N2-3)");
  const text = r.notes.join("\n");
  assert.match(text, /row\[1\] has no citation/);
  assert.match(text, /row\[6\]: no target_year and no absent\.target_year/);
  assert.match(text, /citation refused: host "mondaq\.com" does not resolve to a codified class/);
  assert.match(text, /manufacturer "Nobody Inc" not found/);
  assert.match(text, /energy_density_wh_kg is set with no density_basis/);
  assert.match(text, /tech_category "flying_car" is not one of/);
  assert.equal(db.writes.length, 0);
  const gap = await runProducer(makeDeps({ db }).deps, { spec: oemRoadmapRows, text: "" });
  assert.equal(gap.outcome, "ok");
  assert.equal(gap.counts.gap, 1);
  assert.equal(db.writes.length, 0, "no rows file records a gap and never an invented row");
});

test("rows files: p90 below p50 is refused, a missing both is an error, a same-corridor reroute by another route is a row, a typed multiplier is refused, an unresolved corridor is never minted", async () => {
  const j = spine("jurisdiction", ["Great Britain"]);
  const run = (spec: ProducerSpec, entities: Array<Record<string, unknown>>, row: object) => runProducer(makeDeps({ db: memoryDb({ entities }) }).deps, { spec, text: JSON.stringify([row]) });
  const g = (o: object) => ({ jurisdiction_name: "Great Britain", dso_name: "DSO", capacity_band_mw: "10-20", as_of: "2026-09-01", queue_months_p50: 10, queue_months_p90: 20, citation: cite, ...o });
  assert.equal((await run(gridQueueRows, j, g({}))).counts.parsed, 1);
  const bad = await run(gridQueueRows, j, g({ queue_months_p90: 5 }));
  assert.equal(bad.counts.parsed, 0);
  assert.match(bad.notes.join("|"), /p90 \(5\) < queue_months_p50 \(10\)/);
  const none = await run(gridQueueRows, j, g({ queue_months_p50: null, queue_months_p90: null }));
  assert.equal(none.counts.parsed, 0);
  assert.match(none.notes.join("|"), /at least one of/);
  assert.match((await run(gridQueueRows, j, g({ queue_months_p50: -1 }))).notes.join("|"), /must be >= 0/);
  const c = spine("corridor", ["A-B:ocean", "A-C:ocean"]);
  const rr = (o: object) => ({ baseline_corridor_name: "A-B:ocean", reroute_corridor_name: "A-C:ocean", route_via: "cape_of_good_hope", cause: "closure", effective_from: "2026-01-01", citation: cite, ...o });
  assert.equal((await run(rerouteRows, c, rr({}))).counts.parsed, 1);
  assert.equal((await run(rerouteRows, c, rr({ reroute_corridor_name: "A-B:ocean" }))).counts.parsed, 1, "Suez and the Cape of one port pair are one corridor entity");
  assert.equal((await run(rerouteRows, c, rr({ reroute_corridor_name: undefined }))).counts.parsed, 1, "no reroute name means the same corridor");
  assert.match((await run(rerouteRows, c, rr({ route_via: "sea" }))).notes.join("|"), /route_via "sea" is not one of/);
  const miss = await run(rerouteRows, c, rr({ reroute_corridor_name: "Z-Z:air" }));
  assert.equal(miss.counts.parsed, 0);
  assert.match(miss.notes.join("|"), /MISSING/);
  assert.match((await run(rerouteRows, c, rr({ fuel_burn_multiplier: 1.3 }))).notes.join("|"), /typed fuel_burn_multiplier \(1\.3\) is refused/);
  assert.match((await run(rerouteRows, c, rr({ effective_to: "2025-01-01" }))).notes.join("|"), /before effective_from/);
});

test("rows files: an apply (armed) stores the registered source on the grid row and a re-run inserts nothing twice", async () => {
  const db = memoryDb({ entities: spine("jurisdiction", ["Great Britain"]), sources: [{ id: "src-1", url: "https://eur-lex.europa.eu/", status: "active", base_tier: 1, institution_id: "inst" }], agent_run_searches: [{ id: "cap-cited", intelligence_item_id: null, result_url: cite.url, result_content: "the quoted q sentence of the cited page", result_index: 0 }] });
  const d = makeDeps({ db, env: { OPERATIONS_PRODUCER_GRID_QUEUE_ROWS_ENABLED: "1" } });
  const row = { jurisdiction_name: "Great Britain", dso_name: "DSO", capacity_band_mw: "10-20", as_of: "2026-09-01", queue_months_p50: 10, queue_months_p90: 20, citation: cite };
  const armed = ON(gridQueueRows);
  const r = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([row]) });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.created, 1);
  assert.equal(db.tables.grid_connection_queues?.[0]?.source_id, "src-1");
  const unchecked = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([{ ...row, dso_name: "Other DSO", citation: { ...cite, quote: "a sentence the cited page never held" } }]) });
  assert.equal(unchecked.counts.created, 0, "a quote no stored capture of the cited URL holds writes no row");
  assert.match(unchecked.notes.join("|"), /quote_not_in_capture/);
  const again = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([row]) });
  assert.equal(again.counts.created, 0);
  assert.equal(rerouteRows.table, "reroute_events");
});

// ---- published price statistics ----
test("INV-047: display rows derive only from RATIFIED entries with an observation; an unratified entry or an unobserved series makes no row; the six oil bulletin entries are ratified in the seeded table", async () => {
  assert.equal(SEEDED_SERIES.filter((r) => r.status === "ratified").length, 6);
  const live = (id: string) => ({ id, provenance_status: "verified", is_archived: false, replaced_by: null });
  const [i1, i3] = ["4fae403a-ced5-4c8f-82b7-af0fd6127061", "5fae403a-ced5-4c8f-82b7-af0fd6127062"] as const;
  const items = [{ series_key: "a:x", item_id: i1, status: "ratified", cadence_days: 7 }, { series_key: "a:y", item_id: null, status: "pending" }, { series_key: "a:z", item_id: i3, status: "ratified" }];
  const market = [
    { series_key: "a:x", reference_period: "2026-10-05", label: "X", value_numeric: 10, unit: "EUR/1000L", currency: "EUR", as_at_date: "2026-10-05" },
    { series_key: "a:x", reference_period: "2026-10-12", label: "X", value_numeric: 11.5, unit: "EUR/1000L", currency: "EUR", as_at_date: "2026-10-12" },
    { series_key: "a:y", reference_period: "2026-10-12", label: "Y", value_numeric: 1, unit: "EUR/t", currency: "EUR", as_at_date: "2026-10-12" },
  ];
  const db = memoryDb({ market_series_items: items, market_series: market.map((m, i) => ({ id: `m${i}`, ...m })), intelligence_items: [live(i1), live(i3)] });
  const r = await runProducer(makeDeps({ db, env: { MARKET_PRODUCER_PUBLISHED_STATS_ENABLED: "1" } }).deps, { spec: ON(publishedPriceStatistics), dry: false });
  const rows = db.tables.published_price_statistics ?? [];
  assert.equal(r.counts.created, 1);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.item_id, rows[0]?.value_display, rows[0]?.unit, rows[0]?.next_release_at], [i1, "€11.50", "/1000L", "2026-10-19"]);
  const { updated, dispositions } = ratifySeriesItemMap({ "a:y": { item_id: null, status: "pending" }, "a:q": { item_id: null, status: "pending" }, "a:x": { item_id: "i1", status: "ratified" } }, { per_item: [{ id: "a:y", outcome: "minted_verified", item_id: "i9" }, { id: "a:q", outcome: "held" }] });
  assert.equal(updated["a:y"]?.status, "ratified");
  assert.equal(updated["a:q"]?.status, "pending");
  assert.deepEqual(dispositions.map((x) => x.reason ?? x.action), ["ratified", "outcome_not_verified", "already_ratified"]);
});

test("INV-047: an apply writes a display row only for an item that is live and verified; any other attachment is refused by name; the series, the item and the cadence come from the market_series_items table", async () => {
  const ids = SEEDED_SERIES.map((r) => r.item_id as string);
  const market = SEEDED_SERIES.slice(0, 2).map((r, i) => ({ id: `m${i}`, series_key: r.series_key, reference_period: "2026-10-12", label: `L${i}`, value_numeric: 1500, unit: "EUR/1000L", currency: "EUR", as_at_date: "2026-10-12" }));
  const db = memoryDb({ market_series_items: SEEDED_SERIES, market_series: market, intelligence_items: [{ id: ids[0], provenance_status: "verified", is_archived: false, replaced_by: null }, { id: ids[1], provenance_status: "unverified", is_archived: false, replaced_by: null }] });
  const d = makeDeps({ db, env: { MARKET_PRODUCER_PUBLISHED_STATS_ENABLED: "1" } });
  const r = await runProducer(d.deps, { spec: ON(publishedPriceStatistics), dry: false });
  assert.equal(r.outcome, "partial");
  assert.equal(r.counts.created, 1);
  assert.equal(r.counts.ratified_entries, 6);
  assert.equal(db.tables.published_price_statistics?.[0]?.item_id, ids[0]);
  assert.equal(db.tables.published_price_statistics?.[0]?.next_release_at, "2026-10-19", "the cadence comes from the table's cadence_days");
  assert.match(r.notes.join("|"), /is not a live verified item/);
  const dry = await runProducer(makeDeps({ noDb: true }).deps, { spec: publishedPriceStatistics });
  assert.equal(dry.outcome, "ok", "a dry run reads nothing and says so");
});

test("IMP-084 degraded: market_series_items absent (production before the cutover) makes the producer's run FAILED with a note naming 0029/0030, and it writes nothing; a pending attachment is never ratified", async () => {
  const absent = memoryDb({ market_series: [], intelligence_items: [] }, { failures: [{ table: "market_series_items", op: "select", message: "relation does not exist", code: "PGRST205" }] });
  const r = await runProducer(makeDeps({ db: absent, env: { MARKET_PRODUCER_PUBLISHED_STATS_ENABLED: "1" } }).deps, { spec: ON(publishedPriceStatistics), dry: false });
  assert.equal(r.outcome, "failed");
  assert.match(r.notes.join("|"), /market_series_items is absent \(migrations 0029, 0030, 0044 and 0045 are not applied\)/);
  assert.equal((absent.tables.published_price_statistics ?? []).length, 0);
  const pending = memoryDb({ market_series_items: [{ series_key: "a:x", item_id: "4fae403a-ced5-4c8f-82b7-af0fd6127061", status: "pending" }], market_series: [{ id: "m", series_key: "a:x", reference_period: "2026-10-12", label: "X", value_numeric: 1, unit: "EUR/t", currency: "EUR", as_at_date: "2026-10-12" }], intelligence_items: [] });
  const none = await runProducer(makeDeps({ db: pending, env: { MARKET_PRODUCER_PUBLISHED_STATS_ENABLED: "1" } }).deps, { spec: ON(publishedPriceStatistics), dry: false });
  assert.deepEqual([none.outcome, none.counts.ratified_entries, (pending.tables.published_price_statistics ?? []).length], ["ok", 0, 0]);
});

// ---- spec 09 calculators ----
test("calculators: the refused TCO crossover, the fuel-burn multiplier and the five-surface chain", () => {
  assert.equal(tcoCrossoverBand().label, "M");
  assert.match(String((tcoCrossoverBand() as { reason?: string }).reason), /not forecastable/);
  assert.equal(applyFuelBurnMultiplier({ baselineFuelBurn: 100, fuelBurnMultiplier: 1.25 }).value, 125);
  assert.equal(applyFuelBurnMultiplier({ baselineFuelBurn: 100, fuelBurnMultiplier: 0 }).label, "M");
  assert.equal(compoundingChain().length, 6);
  assert.equal(compoundingChain().filter((s) => s.computedHere).length, 1);
  void NOW;
});
